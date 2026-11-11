# Keep the log redactor and the report scanner apart

Two pattern sets rewrite secrets, on purpose. `src/observability/redact.js` rewrites a log line in place and keeps the field name (`access_token=[REDACTED]`). `src/observability/secrets.js` returns the findings it saw, with their index and their kind, and rewrites each span to `[REDACTED]<kind>`.

A log line needs the label that a report wants gone, so the two sets have different outputs and different readers. One set cannot serve both.

The report scanner moved out of `src/driver/checks.js` in [#38](https://github.com/Bafbi/monoplayer/issues/38). Custody imports it, and a security boundary may not depend on a validation lane. The move did not change what either path prints.

## Considered options

- **Merge into one table with the report's tagged output.** Rejected: every log line changes from `access_token=[REDACTED]` to `access_token=[REDACTED]<assignment>`, and `Bearer` stops being a label. `src/observability/redact.js` documents those labelled shapes, and the redaction sentinel test in `test/service/monoplayer.test.js` reads the label.
- **Merge into one table with the log's label output.** Rejected: the driver's reports lose the finding kind, which is what `src/driver/run.js` counts to print "N secret-shaped string(s) redacted".
- **Run both in sequence.** Rejected: the scanner treats an existing `[REDACTED]` sentinel as a value and eats the brace after it, so `{access_token=[REDACTED]}` stops being valid JSON. Redacted report JSON must still parse.
- **Merge to close the open leaks at the same time.** Rejected: the union of the two sets closes neither leak. `redactSecrets` misses a JSON-quoted key that `redact` catches. Both sets also let an `Authorization: Bearer <opaque>` value through, because the field rule reads the word "Bearer" as the value, and a wider shape list would still read it that way. Closing these takes a key-regex change and its own failing tests.

## The two gaps closed on each side ([#92](https://github.com/Bafbi/monoplayer/issues/92))

The merge stayed refused. The gaps it would have closed got closed by a key-regex change in each set, which is what this ADR said they needed.

- **The JSON-quoted key.** JSON puts a quote between the key and the separator, so `{"access_token":"x"}` matched no key rule in `secrets.js` and none in custody's `LOCAL_ASSIGNMENT`, though `redact.js` caught it through its `("?)` group. Both key rules now accept a closing quote before the `:`.
- **The bearer value.** The field rule read the scheme word as the value and stopped at the space, so the token after `Authorization: Bearer` survived both paths. `redact.js` takes the scheme word with the value inside its field rule, and `secrets.js` has a `bearer` rule with its own kind, so a report still says which shape leaked.
- **The sentinel is never a value.** A redacted span is the result of redacting. The key rule in each set skips a value that begins with the sentinel, so a line passed through twice stays byte-identical and a second pass cannot eat the kind the first pass wrote. That is the chaining bug above.

Each gap has its own test in `test/observability/redact.test.js`, `test/observability/secrets.test.js`, `test/custody/status.test.js`, and the custody CLI pair in `test/custody/cli.test.js`. A scheme word is two edits, one per set, because it is a shape and not a key.

The custody CLI counts the strings a report carried before it redacts them, because the sentinel it writes is not a finding. Scanning the redacted text was counting the redactor's own output.

## Consequences

- A new secret shape has two homes, and three when it is auth-specific. The two are `SECRET_FIELDS` in `redact.js` and the `ASSIGNMENT` key list in `secrets.js`. The third is `LOCAL_ASSIGNMENT` in `src/custody/status.js`.
- Two leaks that the header of `src/observability/secrets.js` used to name are closed, on each side and with their own tests ([#92](https://github.com/Bafbi/monoplayer/issues/92)). The sets stay apart: closing them changed what each set prints, and never made one set serve both readers.
- `test/custody/imports.test.js` fails when custody imports anything from `src/driver/` except the RCON adapter, which `docs/adr/name-the-tree-after-the-domain.md` keeps in the driver tree. It fails on a default, named, namespace, star, side-effect, or dynamic import. It also fails on anything this test cannot see through: a computed specifier, or a CommonJS `require` built with `createRequire`.
- The custody CLI does not import the scanner directly. It reaches it through custody's report helpers (`redactForReport`, `scanForLeaks`), because it uses no scanner symbol itself.
