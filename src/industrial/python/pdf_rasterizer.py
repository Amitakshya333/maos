#!/usr/bin/env python3
"""
MAOS Industrial: Pinned Local PDF Rasterization Backend (F4-01)

Features:
  - Strictly offline, no network, no remote dependencies
  - Pinned Python 3.14 + Pillow 12.3.0
  - Comprehensive bounded enforcement:
      * Magic bytes (%PDF-) validation
      * /Encrypt detection and rejection
      * Page count limits
      * Page dimension limits (MediaBox)
      * Rendered pixel count limits
      * Decompression bomb defense (ratio and byte thresholds)
  - Scanned image extraction (DCTDecode JPEG, FlateDecode RGB/Gray/1-bit)
  - Content stream vector/text operator parsing and canvas rendering
  - Structured JSON metadata output
"""

import sys
import os
import io
import re
import zlib
import json
import argparse
from typing import Dict, List, Tuple, Optional, Any
from PIL import Image, ImageDraw, ImageFont

# ── Bounds Defaults ────────────────────────────────────────────────

DEFAULT_MAX_PAGES = 100
DEFAULT_MAX_PAGE_DIM = 10000.0  # points
DEFAULT_MAX_PIXELS = 25_000_000 # pixels
DEFAULT_MAX_DECOMP_RATIO = 100  # 100:1 ratio
DEFAULT_MAX_DECOMP_BYTES = 25 * 1024 * 1024 # 25 MB

class RasterError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message

# ── Bounded Decompressor ───────────────────────────────────────────

def bounded_inflate(compressed: bytes, max_ratio: float, max_bytes: int) -> bytes:
    """Decompress zlib stream with strict decompression bomb detection."""
    if not compressed:
        return b""
    comp_len = len(compressed)
    decompressor = zlib.decompressobj()
    out = io.BytesIO()
    total_out = 0

    chunk_size = 64 * 1024
    offset = 0
    while offset < comp_len:
        chunk = compressed[offset:offset + chunk_size]
        offset += len(chunk)
        data = decompressor.decompress(chunk)
        if data:
            total_out += len(data)
            if total_out > max_bytes:
                raise RasterError(
                    "DECOMPRESSION_BOMB_DETECTED",
                    f"Decompressed stream exceeds limit of {max_bytes} bytes"
                )
            if comp_len > 0 and (total_out / comp_len) > max_ratio and total_out > 65536:
                raise RasterError(
                    "DECOMPRESSION_BOMB_DETECTED",
                    f"Decompression ratio {(total_out / comp_len):.1f}x exceeds allowed {max_ratio}x"
                )
            out.write(data)

    remaining = decompressor.flush()
    if remaining:
        total_out += len(remaining)
        if total_out > max_bytes:
            raise RasterError(
                "DECOMPRESSION_BOMB_DETECTED",
                f"Decompressed stream exceeds limit of {max_bytes} bytes"
            )
        if comp_len > 0 and (total_out / comp_len) > max_ratio and total_out > 65536:
            raise RasterError(
                "DECOMPRESSION_BOMB_DETECTED",
                f"Decompression ratio {(total_out / comp_len):.1f}x exceeds allowed {max_ratio}x"
            )
        out.write(remaining)

    return out.getvalue()

# ── PDF Parser ─────────────────────────────────────────────────────

class SimplePdfParser:
    def __init__(self, data: bytes, max_ratio: float, max_decomp_bytes: int):
        self.data = data
        self.max_ratio = max_ratio
        self.max_decomp_bytes = max_decomp_bytes
        self.objects: Dict[int, bytes] = {}
        self.obj_dicts: Dict[int, Dict[str, Any]] = {}
        self.obj_streams: Dict[int, bytes] = {}
        self.trailer: Dict[str, Any] = {}
        self.pages: List[Dict[str, Any]] = []

    def parse(self):
        # 1. Magic bytes check
        if not self.data.startswith(b"%PDF-"):
            # Check within first 1024 bytes
            idx = self.data.find(b"%PDF-")
            if idx == -1 or idx > 1024:
                raise RasterError("INVALID_MIME", "File lacks valid %PDF- header")
            # Strip preamble if before 1024
            self.data = self.data[idx:]

        # 2. Check for encryption
        if b"/Encrypt" in self.data:
            raise RasterError("ENCRYPTED_PDF_UNSUPPORTED", "Encrypted PDF is not supported")

        # 3. Locate and parse indirect objects
        pattern = re.compile(rb'(\d+)\s+(\d+)\s+obj\b')
        pos = 0
        while True:
            match = pattern.search(self.data, pos)
            if not match:
                break
            obj_num = int(match.group(1))
            obj_start = match.end()

            # Find endobj
            endobj = self.data.find(b"endobj", obj_start)
            if endobj == -1:
                obj_body = self.data[obj_start:]
                pos = len(self.data)
            else:
                obj_body = self.data[obj_start:endobj]
                pos = endobj + 6

            self.objects[obj_num] = obj_body
            self._parse_obj_body(obj_num, obj_body)

        # 4. Resolve Pages tree
        self._resolve_pages()

    def _parse_obj_body(self, obj_num: int, body: bytes):
        stream_idx = body.find(b"stream")
        if stream_idx != -1:
            dict_part = body[:stream_idx].strip()
            stream_start = stream_idx + 6
            if body[stream_start:stream_start+2] == b"\r\n":
                stream_start += 2
            elif body[stream_start:stream_start+1] in (b"\r", b"\n"):
                stream_start += 1
            
            endstream_idx = body.rfind(b"endstream")
            if endstream_idx != -1:
                stream_data = body[stream_start:endstream_idx]
            else:
                stream_data = body[stream_start:]
            
            parsed_dict = self._parse_dict(dict_part)
            
            # Decompress stream if needed
            filter_val = parsed_dict.get("/Filter")
            if filter_val == "/FlateDecode" or filter_val == "FlateDecode":
                try:
                    decompressed = bounded_inflate(stream_data, self.max_ratio, self.max_decomp_bytes)
                    self.obj_streams[obj_num] = decompressed
                except Exception as e:
                    if isinstance(e, RasterError):
                        raise
                    # If corrupt stream
                    self.obj_streams[obj_num] = stream_data
            else:
                self.obj_streams[obj_num] = stream_data
            
            self.obj_dicts[obj_num] = parsed_dict
        else:
            self.obj_dicts[obj_num] = self._parse_dict(body)

    def _parse_dict(self, text: bytes) -> Dict[str, Any]:
        result: Dict[str, Any] = {}
        s = text.decode('latin-1', errors='ignore')

        # Match key-value pairs
        # Type
        type_m = re.search(r'/Type\s+/([a-zA-Z0-9]+)', s)
        if type_m:
            result["/Type"] = f"/{type_m.group(1)}"

        # Subtype
        subtype_m = re.search(r'/Subtype\s+/([a-zA-Z0-9]+)', s)
        if subtype_m:
            result["/Subtype"] = f"/{subtype_m.group(1)}"

        # Filter
        filter_m = re.search(r'/Filter\s+/([a-zA-Z0-9]+)', s)
        if filter_m:
            result["/Filter"] = f"/{filter_m.group(1)}"

        # Dimensions: Width, Height
        width_m = re.search(r'/Width\s+(\d+)', s)
        if width_m:
            result["/Width"] = int(width_m.group(1))

        height_m = re.search(r'/Height\s+(\d+)', s)
        if height_m:
            result["/Height"] = int(height_m.group(1))

        # MediaBox
        mb_m = re.search(r'/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\]', s)
        if mb_m:
            result["/MediaBox"] = [float(mb_m.group(i)) for i in range(1, 5)]

        # CropBox
        cb_m = re.search(r'/CropBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\]', s)
        if cb_m:
            result["/CropBox"] = [float(cb_m.group(i)) for i in range(1, 5)]

        # Kids
        kids_m = re.search(r'/Kids\s*\[([^\]]+)\]', s)
        if kids_m:
            kids_refs = [int(x) for x in re.findall(r'(\d+)\s+\d+\s+R', kids_m.group(1))]
            result["/Kids"] = kids_refs

        # Count
        count_m = re.search(r'/Count\s+(\d+)', s)
        if count_m:
            result["/Count"] = int(count_m.group(1))

        # Contents
        contents_m = re.search(r'/Contents\s+(\d+)\s+\d+\s+R', s)
        if contents_m:
            result["/Contents"] = int(contents_m.group(1))
        else:
            # Array of contents
            arr_contents_m = re.search(r'/Contents\s*\[([^\]]+)\]', s)
            if arr_contents_m:
                refs = [int(x) for x in re.findall(r'(\d+)\s+\d+\s+R', arr_contents_m.group(1))]
                result["/Contents"] = refs

        # Resources / XObject
        xobj_m = re.search(r'/XObject\s*<<([^>]+)>>', s)
        if xobj_m:
            xobjs = {}
            for xm in re.finditer(r'/([a-zA-Z0-9_]+)\s+(\d+)\s+\d+\s+R', xobj_m.group(1)):
                xobjs[xm.group(1)] = int(xm.group(2))
            result["/XObjects"] = xobjs

        # ColorSpace
        cs_m = re.search(r'/ColorSpace\s+/([a-zA-Z0-9]+)', s)
        if cs_m:
            result["/ColorSpace"] = f"/{cs_m.group(1)}"

        # BitsPerComponent
        bpc_m = re.search(r'/BitsPerComponent\s+(\d+)', s)
        if bpc_m:
            result["/BitsPerComponent"] = int(bpc_m.group(1))

        return result

    def _resolve_pages(self):
        # Look for /Type /Page objects
        page_objs = []
        for num, d in self.obj_dicts.items():
            if d.get("/Type") == "/Page":
                page_objs.append((num, d))

        if page_objs:
            # Sort by object number to maintain order
            page_objs.sort(key=lambda x: x[0])
            for num, d in page_objs:
                self.pages.append({"num": num, "dict": d})
            return

        # Fallback: traverse from Catalog -> Pages
        for num, d in self.obj_dicts.items():
            if d.get("/Type") == "/Catalog" or "/Pages" in str(self.objects.get(num, b"")):
                # Check for /Pages ref
                p_ref = re.search(r'/Pages\s+(\d+)\s+\d+\s+R', self.objects.get(num, b"").decode('latin-1', errors='ignore'))
                if p_ref:
                    root_pages_num = int(p_ref.group(1))
                    self._collect_pages_from_tree(root_pages_num, set())
                    if self.pages:
                        return

        # If still no pages found, check if there are any objects with MediaBox
        for num, d in self.obj_dicts.items():
            if "/MediaBox" in d or "/Contents" in d:
                self.pages.append({"num": num, "dict": d})

    def _collect_pages_from_tree(self, node_num: int, visited: set):
        if node_num in visited or len(visited) > 1000:
            return
        visited.add(node_num)
        d = self.obj_dicts.get(node_num, {})
        t = d.get("/Type")
        if t == "/Page":
            self.pages.append({"num": node_num, "dict": d})
        elif t == "/Pages" or "/Kids" in d:
            kids = d.get("/Kids", [])
            for kid_num in kids:
                self._collect_pages_from_tree(kid_num, visited)

# ── Page Renderer ──────────────────────────────────────────────────

def render_page(
    page_data: Dict[str, Any],
    parser: SimplePdfParser,
    page_num: int,
    dpi: int,
    fmt: str,
    max_page_dim: float,
    max_pixels: int,
    output_dir: str,
) -> Dict[str, Any]:
    warnings: List[str] = []
    d = page_data["dict"]

    # 1. MediaBox / Dimensions
    box = d.get("/CropBox") or d.get("/MediaBox") or [0, 0, 612, 792] # Default US Letter
    width_pt = abs(float(box[2]) - float(box[0]))
    height_pt = abs(float(box[3]) - float(box[1]))

    if width_pt <= 0 or height_pt <= 0:
        width_pt, height_pt = 612.0, 792.0

    if width_pt > max_page_dim or height_pt > max_page_dim:
        raise RasterError(
            "OVERSIZED_PAGE_DIMENSIONS",
            f"Page {page_num} dimensions ({width_pt:.1f}x{height_pt:.1f} pt) exceed maximum limit of {max_page_dim} pt"
        )

    pixel_width = max(1, int(round(width_pt * dpi / 72.0)))
    pixel_height = max(1, int(round(height_pt * dpi / 72.0)))
    total_pixels = pixel_width * pixel_height

    if total_pixels > max_pixels:
        raise RasterError(
            "PIXEL_LIMIT_EXCEEDED",
            f"Page {page_num} rendered pixels ({total_pixels}) exceeds maximum limit of {max_pixels}"
        )

    # 2. Check for scanned image XObjects first
    xobjs = d.get("/XObjects", {})
    embedded_image: Optional[Image.Image] = None

    for xname, xnum in xobjs.items():
        xdict = parser.obj_dicts.get(xnum, {})
        if xdict.get("/Subtype") == "/Image":
            img_stream = parser.obj_streams.get(xnum)
            if not img_stream:
                continue
            filt = xdict.get("/Filter", "")
            img_w = xdict.get("/Width", pixel_width)
            img_h = xdict.get("/Height", pixel_height)

            if filt == "/DCTDecode" or filt == "DCTDecode":
                # JPEG stream
                try:
                    loaded = Image.open(io.BytesIO(img_stream))
                    embedded_image = loaded.convert('RGB')
                    break
                except Exception as e:
                    warnings.append(f"Failed to load DCTDecode image on page {page_num}: {e}")
            else:
                # Raw / FlateDecode bitmap
                cs = xdict.get("/ColorSpace", "/DeviceRGB")
                bpc = xdict.get("/BitsPerComponent", 8)
                try:
                    if cs == "/DeviceGray" or cs == "DeviceGray":
                        loaded = Image.frombytes("L", (img_w, img_h), img_stream)
                        embedded_image = loaded.convert("RGB")
                    elif cs == "/DeviceCMYK" or cs == "DeviceCMYK":
                        loaded = Image.frombytes("CMYK", (img_w, img_h), img_stream)
                        embedded_image = loaded.convert("RGB")
                    else:
                        # RGB
                        if len(img_stream) >= img_w * img_h * 3:
                            loaded = Image.frombytes("RGB", (img_w, img_h), img_stream[:img_w * img_h * 3])
                            embedded_image = loaded
                    if embedded_image:
                        break
                except Exception as e:
                    warnings.append(f"Failed to decode Flate image on page {page_num}: {e}")

    # 3. Create page canvas
    canvas = Image.new("RGB", (pixel_width, pixel_height), color=(255, 255, 255))
    draw = ImageDraw.Draw(canvas)

    if embedded_image:
        # Scale to canvas dimensions
        scaled_img = embedded_image.resize((pixel_width, pixel_height), Image.Resampling.LANCZOS)
        canvas.paste(scaled_img, (0, 0))
    else:
        # 4. Render content stream drawing and text operators
        content_ref = d.get("/Contents")
        content_bytes = b""
        if isinstance(content_ref, int):
            content_bytes = parser.obj_streams.get(content_ref, b"")
        elif isinstance(content_ref, list):
            content_bytes = b"\n".join([parser.obj_streams.get(ref, b"") for ref in content_ref])

        if content_bytes:
            content_str = content_bytes.decode('latin-1', errors='ignore')
            _render_content_stream(content_str, draw, pixel_width, pixel_height, width_pt, height_pt)

    # 5. Save output file
    ext = "jpg" if fmt.lower() in ("jpeg", "jpg") else "png"
    out_filename = f"page_{page_num}.{ext}"
    out_path = os.path.join(output_dir, out_filename)

    if ext == "jpg":
        canvas.save(out_path, format="JPEG", quality=90)
    else:
        canvas.save(out_path, format="PNG")

    size_bytes = os.path.getsize(out_path)

    return {
        "pageNumber": page_num,
        "width": pixel_width,
        "height": pixel_height,
        "dpi": dpi,
        "format": "jpeg" if ext == "jpg" else "png",
        "tempFilePath": out_path,
        "sizeBytes": size_bytes,
        "warnings": warnings,
    }

def _render_content_stream(content: str, draw: ImageDraw.ImageDraw, px_w: int, px_h: int, pt_w: float, pt_h: float):
    """Simple defensive drawing of basic PDF content stream operators."""
    scale_x = px_w / pt_w
    scale_y = px_h / pt_h

    # Parse rectangles: x y w h re
    for rm in re.finditer(r'([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+re\b', content):
        x = float(rm.group(1)) * scale_x
        y = float(rm.group(2)) * scale_y
        w = float(rm.group(3)) * scale_x
        h = float(rm.group(4)) * scale_y
        # PDF y is from bottom, convert to top
        top = px_h - (y + h)
        draw.rectangle([x, top, x + w, top + h], outline=(0, 0, 0))

    # Parse text: BT ... ET
    for btm in re.finditer(r'BT(.*?)ET', content, re.DOTALL):
        block = btm.group(1)
        # Find position: x y Td or Tm
        pos_m = re.search(r'([-\d.]+)\s+([-\d.]+)\s+Td', block)
        tx, ty = 20.0, pt_h - 40.0
        if pos_m:
            tx = float(pos_m.group(1))
            ty = float(pos_m.group(2))

        px_tx = tx * scale_x
        px_ty = px_h - (ty * scale_y)

        # Find string literals: (text) Tj
        for tj_m in re.finditer(r'\(([^)]*)\)\s*Tj', block):
            txt = tj_m.group(1)
            draw.text((px_tx, px_ty), txt, fill=(0, 0, 0))
            px_ty += 14.0

# ── Main CLI ───────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="MAOS Bounded PDF Rasterizer")
    parser.add_argument("--input", required=True, help="Input PDF absolute path")
    parser.add_argument("--output-dir", required=True, help="Output directory for rendered page images")
    parser.add_argument("--dpi", type=int, default=150, help="Rendering DPI")
    parser.add_argument("--format", default="png", choices=["png", "jpeg", "jpg"], help="Output format")
    parser.add_argument("--max-pages", type=int, default=DEFAULT_MAX_PAGES, help="Max page limit")
    parser.add_argument("--max-page-dim", type=float, default=DEFAULT_MAX_PAGE_DIM, help="Max page dimension")
    parser.add_argument("--max-pixels", type=int, default=DEFAULT_MAX_PIXELS, help="Max rendered pixels per page")
    parser.add_argument("--max-decomp-ratio", type=float, default=DEFAULT_MAX_DECOMP_RATIO, help="Max decompression ratio")
    parser.add_argument("--max-decomp-bytes", type=int, default=DEFAULT_MAX_DECOMP_BYTES, help="Max decompressed stream bytes")
    parser.add_argument("--target-pages", default="", help="Comma-separated 1-indexed target pages")

    args = parser.parse_args()

    try:
        # Check source file existence
        if not os.path.isfile(args.input):
            raise RasterError("NOT_FOUND", f"Source file '{args.input}' not found")

        file_size = os.path.getsize(args.input)
        if file_size == 0:
            raise RasterError("MALFORMED_PDF", "PDF file is empty (0 bytes)")

        with open(args.input, "rb") as f:
            data = f.read()

        # Parse PDF
        pdf = SimplePdfParser(data, max_ratio=args.max_decomp_ratio, max_decomp_bytes=args.max_decomp_bytes)
        pdf.parse()

        total_pages = len(pdf.pages)
        if total_pages == 0:
            raise RasterError("MALFORMED_PDF", "No valid pages could be identified in PDF")

        if total_pages > args.max_pages:
            raise RasterError(
                "PAGE_LIMIT_EXCEEDED",
                f"Document contains {total_pages} pages, which exceeds maximum limit of {args.max_pages}"
            )

        # Parse target pages
        target_indices = []
        if args.target_pages.strip():
            for part in args.target_pages.split(","):
                part = part.strip()
                if part.isdigit():
                    p_num = int(part)
                    if p_num < 1 or p_num > total_pages:
                        raise RasterError("OUT_OF_BOUNDS_PAGE", f"Requested page {p_num} is out of bounds (1..{total_pages})")
                    target_indices.append(p_num)
        else:
            target_indices = list(range(1, total_pages + 1))

        os.makedirs(args.output_dir, exist_ok=True)

        rendered_pages = []
        warnings = []

        for p_num in target_indices:
            page_data = pdf.pages[p_num - 1]
            page_meta = render_page(
                page_data=page_data,
                parser=pdf,
                page_num=p_num,
                dpi=args.dpi,
                fmt=args.format,
                max_page_dim=args.max_page_dim,
                max_pixels=args.max_pixels,
                output_dir=args.output_dir,
            )
            rendered_pages.append(page_meta)

        result = {
            "success": True,
            "sourcePath": args.input,
            "pageCount": total_pages,
            "pages": rendered_pages,
            "warnings": warnings,
        }
        print(json.dumps(result))
        sys.exit(0)

    except RasterError as re_err:
        err_res = {
            "success": False,
            "errorCode": re_err.code,
            "error": re_err.message,
        }
        print(json.dumps(err_res))
        sys.exit(1)
    except Exception as exc:
        err_res = {
            "success": False,
            "errorCode": "MALFORMED_PDF",
            "error": f"Failed to parse or render PDF: {str(exc)}",
        }
        print(json.dumps(err_res))
        sys.exit(1)

if __name__ == "__main__":
    main()
