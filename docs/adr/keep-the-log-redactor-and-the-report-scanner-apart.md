# Keep the log redactor and the report scanner apart

Two pattern sets rewrite secrets, on purpose. `src/observability/redact.js` rewrites a log line in place and keeps the field name (`access_token=[REDACTED]`). `src/observability/secrets.js` returns the findings it saw, with their index and their kind, and rewrites each span to `[REDACTED]<kind>`.

A log line needs the label that a report wants gone, so the two sets have different outputs and different readers. One set cannot serve both.

The report scanner moved out of `src/driver/checks.js` in [#38](https://github.com/Bafbi/monoplayer/issues/38). Custody imports it, and a security boundary may not depend on a validation lane. The move did not change what either path prints.

## Considered options

- **Merge into one table with the report's tagged output.** Rejected: every log line changes from `access_token=[REDACTED]` to `access_token=[REDACTED]<assignment>`, and `Bearer` stops being a label. `src/observability/redact.js` documents those labelled shapes, and `test/service/monoplayer.test.js:403` reads the label.
- **Merge into one table with the log's label output.** Rejected: the driver's reports lose the finding kind, which is what `src/driver/run.js` counts to print "N secret-shaped string(s) redacted".
- **Run both in sequence.** Rejected: the scanner treats an existing `[REDACTED]` sentinel as a value and eats the brace after it, so `{access_token=[REDACTED]}` stops being valid JSON. Redacted report JSON must still parse.
- **Merge to close the open leaks at the same time.** Rejected: the union of the two sets closes neither leak. `redactSecrets` misses a JSON-quoted key that `redact` catches. Both sets also let an `Authorization: Bearer <opaque>` value through, because the field rule reads the word "Bearer" as the value, and a wider shape list would still read it that way. Closing these takes a key-regex change and its own failing tests.

## Consequences

- A new secret shape has two homes, and three when it is auth-specific. The two are `SECRET_FIELDS` in `redact.js` and the `ASSIGNMENT` key list in `secrets.js`. The third is `LOCAL_ASSIGNMENT` in `src/custody/status.js`.
- Two leaks stay open, and the header of `src/observability/secrets.js` names them. Closing them changes redacted output, so they are their own ticket ([#92](https://github.com/Bafbi/monoplayer/issues/92)).
- `test/custody/imports.test.js` fails when custody imports anything from `src/driver/` except the RCON adapter, which `docs/adr/name-the-tree-after-the-domain.md` keeps in the driver tree. It fails on a default, named, namespace, star, side-effect, or dynamic import. It also fails on anything this test cannot see through: a computed specifier, or a CommonJS `require` built with `createRequire`.
- The custody CLI does not import the scanner directly. It reaches it through custody's report helpers (`redactForReport`, `scanForLeaks`), because it uses no scanner symbol itself.
