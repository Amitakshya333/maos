import pytest
import subprocess
import json
import math
import os

def test_rms_calculation():
    proc = subprocess.run(["python", "rms-calculation.py"], capture_output=True, text=True)
    assert proc.returncode == 0
    
    output = json.loads(proc.stdout)
    
    assert abs(output["rms_value"] - 2.6371099711616126) < 1e-6
    assert output["warning_count"] == 2
    assert output["critical_count"] == 1
    assert output["row_count"] == 500

if __name__ == "__main__":
    test_rms_calculation()

