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

Start the cache-only model server in a dedicated terminal before opening Chat:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-industrial-model-server.ps1
```

The launcher resolves the pinned `Qwen/Qwen2.5-3B-Instruct` revision from the
local Hugging Face cache and passes the required host, port, model path, and
device arguments. It never downloads a model. Use `-Device cpu` if CUDA is not
available. Keep this terminal open while using Chat; stop it with Ctrl+C.
Then run `powershell -ExecutionPolicy Bypass -File scripts/industrial-preflight.ps1`
before activation.
