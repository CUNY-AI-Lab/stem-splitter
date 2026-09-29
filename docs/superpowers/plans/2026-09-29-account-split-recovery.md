# Account recovery implementation and verification

1. Preserve the deployed Cloudflare source on a separate account-recovery branch.
2. Add a private, no-store GET /api/jobs using verified CAIL ownership and bounded
   keyset pagination. Do not expose source locators or provider metadata.
3. Recover the rack from that list; keep local storage optional. Clear displayed
   work after session loss and recheck identity on focus/back navigation.
4. Style account links consistently, distinguish temporary hiding from deletion,
   and explain retained account storage without adding internal testing copy.
5. Exercise the real local Worker with synthetic identities and stored audio:
   two people, unowned/expired records, pagination, new browser, blocked storage,
   My account return, outages, retry, signed-out and suspended states.
6. Run shared and Cloudflare regression suites; inspect desktop/mobile captures.
   Keep live sign-in, provider billing and deployment evidence separate.
7. Record legacy-data custody and admission prerequisites in the readiness guide.
   Obtain the exact reviewed source manifest and destination identity before
   building or executing a migration. Do not import a shared class wholesale.
