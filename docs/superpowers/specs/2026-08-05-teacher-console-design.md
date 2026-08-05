# Design: Instructor console — teacher accounts + Listening Guy prompt amendment

**Date:** 2026-08-05
**Status:** Approved

## Goal

Give the two instructors a durable sign-in and a place to steer what Listening
Guy tells students, without redeploying and without editing `prompt.ts`.

## 1. Why not the class code

The class code already gates every endpoint that costs money. It is deliberately
*not* reused here: it is a shared secret that every student in the room holds, so
it cannot gate a control that changes what the coach says to the whole class. The
instructor console is a separate identity boundary, with its own accounts,
sessions, and an e2e test asserting the class code returns 401 against it.

## 2. Credentials

- **PBKDF2-HMAC-SHA256, 210k iterations, 16-byte per-user salt, 32-byte key.**
  Argon2/bcrypt are not available in workerd without shipping WASM; PBKDF2 is in
  WebCrypto natively and 210k iterations matches current OWASP guidance.
- **Plaintext passwords never touch the repo, the database, or a log.**
  `scripts/hash-teacher-password.mjs` reads the password from **stdin** (not
  argv, so it stays out of shell history and the process table) and prints only
  `{username, name, salt, hash, iterations}`.
- **`TEACHER_SEED` is the source of truth.** The Worker upserts those rows on
  boot (once per isolate, idempotent). Consequences worth having:
  - rotating a password = regenerate the entry, update the secret, redeploy;
    no SQL, no admin UI to attack;
  - a wiped D1 or a lost Railway volume re-provisions the same accounts;
  - the database never contains a credential that isn't already in the secret.
- Login returns one message — `Incorrect username or password.` — for both
  unknown user and wrong password, so the endpoint can't enumerate accounts.
  Hash comparison is length-independent.

## 3. Sessions

Opaque 32-byte random token in an **HttpOnly, SameSite=Lax, Path=/** cookie
(`Secure` when the request is HTTPS). Only the **SHA-256 of the token** is
stored, so a database copy yields no live sessions. 30-day TTL, with expired
rows swept opportunistically on each login rather than by a cron.

No token in `localStorage`: these are classroom machines, and an HttpOnly cookie
is not readable by any script that ends up on the page.

## 4. Amendment, not replacement

The teacher edits an **amendment** appended to the system prompt, not the prompt
itself. Placement is load-bearing: the amendment sits *after* the pedagogy block
but *before* the guardrails and task block, and is introduced with "follow these
unless they conflict with the rules above, which always win."

So an instructor can change repertoire, vocabulary, language, and emphasis, but
cannot switch off "never invent timestamps" or the student-data-is-not-
instructions fence — the two rules that keep the coach from fabricating and from
being steerable by whatever a student types into a note. A free-text box that
replaced the whole prompt would have handed those away by accident.

Capped at 2000 characters. Stored in a single-row `assistant_settings` table
with `updated_by` / `updated_at`, surfaced in the UI so co-instructors can see
who last changed it.

**Saving clears the `guides` cache.** Guides are cached per job and were written
under the previous prompt, so a stale cache would silently outlive the edit. The
response reports how many were cleared; they regenerate lazily (~$0.005 each).

`/api/teacher/prompt/preview` renders the exact assembled system prompt, so an
instructor can see where their text lands and that the guardrails still follow.

## 5. Surface

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/teacher/login` | — | sets the session cookie |
| `POST /api/teacher/logout` | — | clears it |
| `GET /api/teacher/me` | cookie | who am I |
| `GET /api/teacher/prompt` | cookie | current amendment + metadata |
| `PUT /api/teacher/prompt` | cookie | save; clears guide cache |
| `GET /api/teacher/prompt/preview` | cookie | full assembled prompt |

UI at `/teacher.html` (`noindex`), reusing the existing console theme.

## Non-goals

- Self-service password change / reset (rotation is a secret update).
- Per-teacher permissions — both accounts are equal.
- Per-class or per-job amendments; this is one class-wide setting.
- Editing the base prompt from the browser (see §4).

## Verification

`npm run test:e2e` — 14 passing, including a dedicated test that covers: class
code rejected with 401, wrong password rejected, unknown user producing the same
message, successful sign-in, amendment saved and attributed, the amendment
appearing in the assembled prompt *alongside* the surviving guardrail text,
persistence across a reload, and 401 again after sign-out.
