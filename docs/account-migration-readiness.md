# Account saves and migration readiness

## Account recovery released; student acceptance still pending

The canonical Cloudflare app has a server-owned Session Rack list. Admitted
students can recover their owned, unexpired splits after signing in. Cloudflare
uploads now use a 90-day retention window. Labels, annotations and the cached
opening Listening Guide are read from
the existing job endpoints. Browser storage is not the ownership authority.

The list uses the current verified CAIL subject, not an email, username or query
parameter. Even administrators receive only their own personal list. Unclaimed
legacy jobs and expired jobs are not listed. Existing per-job, stem, annotation,
Guide and instructor checks remain in force. Local suspension overrides central
Lab access. HIDE removes a card for this visit; it is not a permanent deletion.

Earlier chat transcripts remain browser-local; they are not a cross-device
archive. Remixer layers and takes remain browser-session work that must be
downloaded. This change introduces neither a second identity provider nor a
shared Lab account-storage service.

## Admission comes before application access

Successful CUNY authentication alone is not Lab admission. Central Admission
must resolve a current individual or class membership before STEM Splitter can
create/use the local account. A transition-list entry is not proof of an active
grant. Diagnose a denied person through the current CAIL Admin MCP and maintained
CAIL reconciliation runbook, not by weakening the app's admission check.

Central membership, a Sandbox legacy-account reconciliation, and importing STEM
Splitter recordings are three distinct operations. None automatically performs
the others. Class enrollment does not share students' recordings or confer the
app's Instructor role. See [class access and usage](class-access-and-usage.md).

### Protected admission triage

Use the current MCP contract rather than direct database writes:

1. Search the exact contact address in both person/request search and
   `search_classes`. A missing individual-search result does not establish that
   no class application exists. Read the exact request and `get_person_access`;
   verify `subjectLinked`, effective access, current sources and next steps.
2. Read the legacy reclaim summary separately. `issued` with no claim date is
   not an identity-bound, ready-to-move account. Invitation delivery fields also
   do not establish delivery of the transition's separately exported Outlook
   messages. Do not recreate or rearm an invitation as a diagnostic action.
3. When authorized, `grant_verified_identity_access` can create ordinary
   individual access from an existing verified, linked class request without
   sending email, approving the class, or moving the legacy account. Require an
   explicit role/scope and policy-valid expiry, the freshly read version, a
   saved idempotency key and access readback. A grant receipt is not fresh login
   acceptance. Never substitute a raw subject or email for the linked request.
4. Review class approval independently: course dates, enrollment, allowance and
   notification effects are a separate decision. The public application path
   accepts CUNY-verified applicants without existing Lab membership.
5. Keep an old Sandbox account and its data intact. Normal CUNY sign-in does not
   perform legacy reclaim. Follow the current owner-transition and credential/
   session retirement gates before any named, approved account move. Do not
   apply older design prose as authority where current contracts supersede it.

Read-only references checked on September 29, 2026:

- [CAIL Admission working note](https://github.com/CUNY-AI-Lab/cail-knowledge-base/blob/530c6c873198b9bbd49d9a1b2ed0a42226d089a7/05%20Infrastructure/CAIL%20Tools%20Admission%20Control.md)
- [Ownership and reconciliation](https://github.com/CUNY-AI-Lab/cail-knowledge-base/blob/530c6c873198b9bbd49d9a1b2ed0a42226d089a7/05%20Infrastructure/OpenWebUI%20Access%20Ownership%20and%20Reconciliation.md)
- [Current MCP contract](https://github.com/CUNY-AI-Lab/cail-tools-admission/blob/12634c02b243a5b67caa2028b149e104f92dec92/apps/doorway/docs/ADMISSION-MCP-CONTRACT.md)
- [Public individual/class application](https://ailab.gc.cuny.edu/request-access/)

These links explain contracts, not a person's current authorization. Keep exact
request, membership and transition handles in protected operational evidence,
not this repository. No central account or transition mutation was performed as
part of this readiness review.

## Required before moving legacy recordings

1. Resolve the exact source deployment and take a recoverable, access-controlled
   backup. Inventory only the intended person's records and still-available
   audio. Do not put private exports, identity handles or credentials in Git.
2. Verify the intended destination CAIL identity through the supported account
   process. Email/name matches locate candidates; they do not prove identity
   equivalence. Keep legacy passwords and sessions out of the transfer.
3. Obtain a reviewed, explicit record manifest. Railway's class-shared records
   do not establish individual ownership. Leave ambiguous/shared records
   unassigned until their custody is resolved; never assign the whole class to
   one instructor just to make the rack visible.
4. Preserve original job dates and the remaining source retention interval.
   Railway's legacy policy remains 30 days; Cloudflare's current 90-day setting
   does not authorize extending that source policy during an import. Copy only
   eligible audio, verify bytes/checksums, and enforce the reviewed destination
   expiry. Expired/missing audio
   must be reported, not represented as a playable migrated split.
5. Preserve labels, notes, model/source/license provenance, guide policy
   fingerprints, and relevant folder relationships. Preserve immutable prompt
   history and its original authorship; do not impersonate a current instructor
   to rewrite it. Resolve destination identifier collisions before import.
6. Design an idempotent, journaled import and rollback manifest. Stage and verify
   audio before promoting the reviewed ownership records. Rollback must target
   only this batch and preserve both pre-existing destination work and source.
7. With the admitted person, verify fresh login, account-return discovery,
   playback, notes and export. Verify that a second student cannot list or read
   those records. The new account list discovers approved ownership assignments
   without editing anyone's browser storage.
8. Record separate receipts for source custody, import, destination ownership,
   authenticated acceptance and release. Retain the source deployment until the
   user approves retirement; no Railway operation is authorized by this guide.

## Remaining gates

- PRs #13–#16 are released at the canonical Cloudflare address. On September 29,
  an existing administrator's sign-out/sign-in restored four owned recordings.
  That reused an existing Lab session: it is not fresh CUNY authentication or
  acceptance by a class-only student.
- No legacy source inventory, ownership adjudication, importer or data transfer
  has been performed by this change.
- The user reports approving the affected instructor. Verify her next sign-in
  independently; approval does not perform Sandbox reconciliation or migrate
  STEM Splitter recordings.
- Run a live student save/logout/login/return check after release, plus an
  authorized real separation and Guide check before classroom acceptance.
- Replicate GPU charges do not yet draw down the person's Lab allowance; the
  shared accounting integration remains separate follow-up work. The user
  confirmed existing Replicate billing is covered and should remain unchanged
  for the ten-member/three-visitor daily-count rollout.
