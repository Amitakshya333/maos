import hashlib, pathlib
root=pathlib.Path(__file__).resolve().parent
index=root/'AUTHORITATIVE_EVIDENCE_INDEX.md'
rows=[]
for path in sorted(p for p in root.rglob('*') if p.is_file() and p.name not in {'AUTHORITATIVE_EVIDENCE_INDEX.md','AUTHORITATIVE_EVIDENCE_INDEX.sha256'}):
    data=path.read_bytes()
    rel=path.relative_to(root).as_posix()
    rows.append((rel,len(data),hashlib.sha256(data).hexdigest()))
text='''# Authoritative evidence index — cancellation lifetime correction

This folder is the authoritative final packet for the cancellation callback/disposal correction against `bb871cb191184b5de1b790d42fc452a29f8f072e`. It supersedes only earlier draft packets for this correction; it does not modify or erase historical failure records. The prior rejected four-file packet remains preserved at `C:\\maos\\review-packets\\baseten-pilot-correction-close-2026-10-29` with patch SHA-256 `dbb62ab351b474cd158071b34f47be173f890cb869391b6befa0e9ddb45b8ad1` and manifest SHA-256 `2f089126d37461c4bcb60633bfd35f3845a2b3274d99567c28984a147af64a92`.

The full candidate patch is against the declared base. The focused delta is against the prior four-file snapshot verified after LF normalization. Raw and LF-normalized hashes are both retained where relevant. Old failed runs were preserved and are not overwritten by the final passing validation logs.

| File | Bytes | SHA-256 |
| --- | ---: | --- |
'''
for name,size,digest in rows:
    text+=f'| `{name}` | {size} | `{digest}` |\n'
index.write_text(text,encoding='utf-8',newline='\n')
digest=hashlib.sha256(index.read_bytes()).hexdigest()
(root/'AUTHORITATIVE_EVIDENCE_INDEX.sha256').write_text(f'{digest}  AUTHORITATIVE_EVIDENCE_INDEX.md\n',encoding='ascii',newline='\n')
print(f'INDEX_SHA256={digest}')
print(f'INDEXED_FILES={len(rows)}')
for name,size,digest in rows: print(f'{digest}  {name}')