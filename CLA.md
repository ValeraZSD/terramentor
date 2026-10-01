# Contributor Licence Agreement

> Adapted from the widely-used Apache Individual Contributor Licence Agreement (ICLA) 2.0 and the Harmony 1.0 agreements.

## In short

- You keep the copyright in what you contribute. Nothing here transfers it.
- You give the Maintainer (Valerii Kozhevets, or whoever he assigns the project to; clause 1)
  a permanent licence to use your contribution under the AGPL-3.0-or-later **and under any other
  licence he chooses, including proprietary (closed-source) terms**. That second part is the
  reason this agreement exists; it is not a side effect.
- You also give a patent licence, limited to the patents your own contribution needs.
- You confirm the contribution is yours to give.

The full terms are below and they are what counts; this summary only describes them.

## Why this exists

The project's engine is and will remain **AGPL-3.0-or-later**, free to run, fork, self-host and
audit. Alongside it, the Maintainer intends to offer optional commercial components (a managed
remote-access relay, and later an end-to-end-encrypted sync service) that build on shared code.

Offering that shared code under a second, non-AGPL licence requires permission from everyone who
wrote part of it. This agreement obtains that permission. It does **not** take anything away from
you: you keep full ownership of your contribution and can do anything you like with it elsewhere.

If you would rather not sign, you have two good options:

1. **Add a search provider** (`docs/SEARCH_PROVIDERS.md`). A provider manifest is a few
   fields of data: a name, an icon and a URL template. It still counts as a Contribution
   (clause 1 includes configuration), so if you have signed, clause 2 covers it like anything
   else. If you have not signed and would rather not, say so in the pull request: for a
   pull request that changes nothing but a provider manifest, the Maintainer can allowlist your
   GitHub handle past the signing check, and the manifest is then accepted under the project's
   own licence, AGPL-3.0-or-later, with no grant under clause 2. The same will be true of
   add-ons when they exist (`docs/ADDONS.md`): they are separate works with their own licence.
2. Discuss keeping your change in an AGPL-only module in the issue thread first.

## Terms

By signing below, You agree to the following, for each Contribution You submit to this project.

**1. Definitions.** "You" means the individual or legal entity signing. "Contribution" means any
work of authorship — code, documentation, configuration, translation — that You intentionally
submit to this project for inclusion, in any form, through any channel. "The Maintainer" means
Valerii Kozhevets (GitHub: ValeraZSD), the copyright holder named in the project's README, and
any person or legal entity to which he assigns the project; the licences You grant below pass
to that assignee with it. "This project" means the Terramentor repository at
https://github.com/ValeraZSD/terramentor and the software distributed from it.

**2. Copyright licence.** You grant the Maintainer a perpetual, worldwide,
non-exclusive, royalty-free, irrevocable copyright licence to reproduce, prepare derivative works
of, publicly display, publicly perform, sublicense and distribute Your Contribution and such
derivative works, **under the AGPL-3.0-or-later and under any other licence terms the Maintainer
chooses**, including proprietary terms.

**3. Patent licence.** You grant the Maintainer and recipients of software distributed by
the project a perpetual, worldwide, non-exclusive, royalty-free, irrevocable (except as stated in
this section) patent licence to make, have made, use, offer to sell, sell, import and otherwise
transfer Your Contribution, covering only those patent claims licensable by You that are
necessarily infringed by Your Contribution alone or by its combination with the project. If any
entity institutes patent litigation alleging that the project or a Contribution constitutes
patent infringement, any patent licences granted to that entity under this agreement terminate as
of the date such litigation is filed.

**4. You retain ownership.** You keep all right, title and interest in Your Contribution. Nothing
here assigns Your copyright. You may use, license and distribute Your Contribution however You
wish, in any other context.

**5. You have the right to grant this.** You represent that each Contribution is Your original
creation, or that You have the necessary rights to submit it under these terms. If Your employer
has rights to work You create, You represent that You have permission to contribute, or that
Your employer has waived those rights.

**6. Third-party material.** If Your Contribution includes work You did not author, You will
identify it and its licence clearly in the submission, and You will not include anything whose
licence is incompatible with AGPL-3.0-or-later or with clause 2 above.

**7. No warranty.** Contributions are provided "as is", without warranty of any kind, express or
implied, to the fullest extent permitted by law.

**8. Nothing is owed to You.** The Maintainer is not obliged to use, merge, or keep Your
Contribution, and may remove it at any time.

## How to sign

You sign once, through [CLA Assistant](https://cla-assistant.io/), the bot that holds this
project's CLA check. Open your first pull request as usual: the bot comments on it with a
signature link, one click confirms it against your GitHub account, and the check turns green.
The signature is recorded against that account and covers every later pull request — nothing
is added to any file in the repository.

Every commit must also carry a `Signed-off-by:` line (`git commit -s`) certifying the
[DCO](https://developercertificate.org/).

## Signatories

Signatures are recorded by the CLA Assistant bot, not in this file. The table below is the
historical record from before the bot took the check over, kept for the signatures made
under it.

| Name | GitHub | Date |
|---|---|---|
| Valerii Kozhevets | ValeraZSD | 2026-08-04 |
