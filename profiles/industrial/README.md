# MAOS Industrial profile

This is an optional, local-only MAOS profile. It does not replace the generic
configuration created by `maos init`.

## Activate explicitly

From the repository root, back up the active profile and then select Industrial:

```powershell
Copy-Item .maos/maos.config.json .maos/maos.config.backup.json
Copy-Item .maos/pool.json .maos/pool.backup.json
Copy-Item profiles/industrial/maos.config.json .maos/maos.config.json
Copy-Item profiles/industrial/pool.json .maos/pool.json
```

Restore the generic profile after the demo:

```powershell
Copy-Item .maos/maos.config.backup.json .maos/maos.config.json
Copy-Item .maos/pool.backup.json .maos/pool.json
```

Start the cache-only server with `python scripts/huggingface-openai-server.py`, then run
`powershell -ExecutionPolicy Bypass -File scripts/industrial-preflight.ps1` before activation.
The server discovers the cached `Qwen/Qwen2.5-3B-Instruct` snapshot and never downloads.
