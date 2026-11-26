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

Each gap has its own test in `test/observability/redact.test.js`, `test/observability/secrets.test.js`, `test/custody/status.test.js`, and the custody CLI pair in `test/custody/cli.test.js`. A scheme word is still two edits, one per renderer, because it is a shape and not a key. What changed is where its spelling lives: `redact.js` exports the grammar and neither set writes its own.

The custody CLI counts the strings a report carried before it redacts them, because the sentinel it writes is not a finding. Scanning the redacted text was counting the redactor's own output.

## One vocabulary, two renderers ([#181](https://github.com/Bafbi/monoplayer/issues/181), [#182](https://github.com/Bafbi/monoplayer/issues/182), [#183](https://github.com/Bafbi/monoplayer/issues/183))

The sets stay apart. What they stopped doing is each spelling its own idea of what a secret is, and that spelling is where three leaks came from.

- **One key list.** `SECRET_FIELDS` in `src/observability/redact.js` is the only list of names whose value is a secret. `secrets.js` imports it and reads it, and custody's prepass is gone, so a name redacted on the log path is redacted on the report path by construction. `test/observability/redaction-parity.test.js` reads that list and drives both paths, so a name wired into one renderer fails there. The lists disagreed on which names held a secret ([#181](https://github.com/Bafbi/monoplayer/issues/181), [#183](https://github.com/Bafbi/monoplayer/issues/183)), and neither was a superset of the other. One list cannot disagree with itself.
- **One credential grammar.** `CREDENTIAL_SCHEME`, `KNOWN_SCHEMES`, `CREDENTIAL` and `CREDENTIAL_SHAPE` are exported from `redact.js`, and each set composes its own rule around them. The scheme behind an `authorization` field is any RFC 7235 token, because the field name scopes the match. A bare credential needs one of four named schemes and one character outside `[A-Za-z]`: an open scheme match rewrites prose, and a length floor alone cannot tell `Basic authentication` from a credential ([#182](https://github.com/Bafbi/monoplayer/issues/182)).
- **The kind names the scheme.** `<bearer>` keeps the meaning [#92](https://github.com/Bafbi/monoplayer/issues/92) gave it, and `<basic>`, `<digest>` and `<negotiate>` follow. A header with no scheme word is `<authorization>`. A new scheme behind the field needs no edit at all; one that stands bare needs a line in `KNOWN_SCHEMES` and a credential that carries a character outside `[A-Za-z]`.
- **The prepass left.** Custody's `LOCAL_ASSIGNMENT` was a third key list, with its own six-character floor and its own key-named tag. It missed its own `device_code_pairing` sibling, and a report carrying `access_token` produced two findings, so `warning: N secret-shaped string(s)` counted one secret twice. One pass can do neither.
- **The widening, and what it costs.** [#183](https://github.com/Bafbi/monoplayer/issues/183) asked which way the trade goes. The log path gains `token`, `secret`, `bearer`, `credential`, `passwd` and `api[-_]?key`, because the report path already read them and one list means one answer. The cost is log volume: a field named `token` with an innocuous value now prints `token=[REDACTED]`, and `redact()` keeps no count, so the volume is untracked and unbounded by this decision. A key rule reading a bare `token` substring also reads `my_token` as `token`, which shortens the label and redacts the value. Both are the safe direction, and neither is worth a second list.
- **The cost.** The report path keeps the eight-character floor. The prepass tagged at six, so a six- or seven-character value under an auth key is no longer tagged in a report. Every auth value this tree produces is longer: the Microsoft user code is nine characters, and a device code is `ABCD-1234-EFGH`.

## Consequences

- A new secret **name** has one home, `SECRET_FIELDS` in `src/observability/redact.js`. A new secret **shape** has two renderers, one per output, each composed from the credential grammar that module exports. There is no third home: custody's prepass is gone ([#181](https://github.com/Bafbi/monoplayer/issues/181)).
- Two leaks that the header of `src/observability/secrets.js` used to name are closed, on each side and with their own tests ([#92](https://github.com/Bafbi/monoplayer/issues/92)). The sets stay apart: closing them changed what each set prints, and never made one set serve both readers.
- `test/custody/imports.test.js` fails when custody imports anything from `src/driver/` except the RCON adapter, which `docs/adr/name-the-tree-after-the-domain.md` keeps in the driver tree. It fails on a default, named, namespace, star, side-effect, or dynamic import. It also fails on anything this test cannot see through: a computed specifier, or a CommonJS `require` built with `createRequire`.
- The custody CLI does not import the scanner directly. It reaches it through custody's report helpers (`redactForReport`, `scanForLeaks`), because it uses no scanner symbol itself.
