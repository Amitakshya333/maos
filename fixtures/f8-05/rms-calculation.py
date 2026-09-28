import sys
import csv
import json
import numpy as np

def main():
    try:
        with open("turbine_vibration_log.csv", "r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            rows = list(reader)
        
        values = []
        warning_rows = []
        critical_rows = []
        
        for idx, row in enumerate(rows, start=1):
            val = float(row["vibration_rms_mm_s"])
            values.append(val)
            if val >= 4.5:
                warning_rows.append([idx, val])
            if val >= 7.1:
                critical_rows.append([idx, val])
                
        val_array = np.array(values)
        rms = float(np.sqrt(np.mean(val_array**2)))
        
        res = {
            "rms_value": rms,
            "warning_count": len(warning_rows),
            "critical_count": len(critical_rows),
            "row_count": len(values),
            "warning_rows": warning_rows,
            "critical_rows": critical_rows
        }
        
        print(json.dumps(res))
        sys.exit(0)
    except Exception as e:
        sys.exit(1)

if __name__ == "__main__":
    main()
