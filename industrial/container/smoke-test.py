#!/usr/bin/env python3
"""
MAOS Industrial — Sandbox Offline Smoke Test (F8-01)
Validates non-root runtime, approved library imports, and anti-install guarantees.
"""

import sys
import os
import shutil

def main():
    print("[1/5] Checking non-root execution identity...")
    try:
        if os.getuid() == 0:
            print("ERROR: Running as root (UID 0) is strictly forbidden!", file=sys.stderr)
            sys.exit(1)
        uid = os.getuid()
        print(f"PASS: Running as non-root user (UID: {uid})")
    except AttributeError:
        # Windows fallback during local static testing
        print("PASS: (Non-POSIX platform; os.getuid not available)")

    print("[2/5] Testing approved package imports...")
    try:
        import numpy as np
        import pandas as pd
        import scipy
        import sympy
        import matplotlib
        import pytest
        print("PASS: All approved packages imported successfully:")
        print(f"      numpy={np.__version__}, pandas={pd.__version__}, scipy={scipy.__version__}")
        print(f"      sympy={sympy.__version__}, matplotlib={matplotlib.__version__}, pytest={pytest.__version__}")
    except ImportError as e:
        print(f"ERROR: Failed to import approved package: {e}", file=sys.stderr)
        sys.exit(2)

    print("[3/5] Testing deterministic calculation capability...")
    data = [1.2, 2.4, 3.6, 4.8, 6.0]
    mean_val = float(np.mean(data))
    expected_mean = 3.6
    if abs(mean_val - expected_mean) > 1e-9:
        print(f"ERROR: Calculation mismatch: got {mean_val}, expected {expected_mean}", file=sys.stderr)
        sys.exit(3)
    print(f"PASS: Vectorized arithmetic verified (mean = {mean_val})")

    print("[4/5] Verifying absence of package management binaries...")
    pip_path = shutil.which("pip") or shutil.which("pip3")
    if pip_path:
        print(f"ERROR: Runtime package installer found at {pip_path}! It must be stripped.", file=sys.stderr)
        sys.exit(4)
    print("PASS: Package installers (pip/pip3) confirmed absent.")

    print("[5/5] All offline sandbox image smoke tests PASSED.")
    return 0

if __name__ == "__main__":
    sys.exit(main())
