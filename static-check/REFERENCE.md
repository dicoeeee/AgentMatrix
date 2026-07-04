# Static Check Reference

## Stage Report

Use this minimum shape:

```json
{
  "stage_id": "static_check",
  "status": "success",
  "summary": "Static gates completed.",
  "commands": [],
  "findings": [],
  "artifacts": [],
  "skipped": [],
  "changed_files": []
}
```

## Command Evidence

Each command entry records:

- `name`
- `command`
- `exit_code`
- `status`: `success`, `failed`, or `skipped`
- `parallel_group` when it ran concurrently
- `duration_ms` when available
- `reason` when skipped

## Findings

Each finding records:

- `severity`: `blocker`, `major`, `minor`, or `nit`
- `source`: formatter, lint, typecheck, security, dependency, or unsupported
- `message`
- `file` and `line` when available
- `fix_applied`: true or false

## Completion Evidence

The static_check stage can satisfy these criteria from the report:

- `output_exists: static_check_report`
- `schema_valid: static_check_report`
- `commands_ok: static_check_report`
- `no_blockers: static_check_report`
- `skip_reasons_present: static_check_report`
