# BM 2 — Contacts Import: methodology (validated on the real dataset)

> Companion to `docs/bm2/bp-contacts-design.md` and the Phase D build in `docs/bm2/bp-ops-surfaces.md`.
> This is the **methodology + the numbers**, derived by running the rules over the client's real
> "before-processing" folder (`contacts list/projects_contacts`, 426 files). It replaces the
> assumptions in the original design with measured reality. Per-file results:
> `docs/bm2/import-analysis/per-file-analysis.csv`.

## 0 · Answer to the product question
**Do not demand a single uniform template from the client.** The xlsx/csv are ingestible as-is with a
mapping wizard + two structural rules; forcing a template is a big ask they'll do inconsistently.
**But** we also cannot blind-ingest the whole folder: file extensions lie, and ~40% of the folder is
PDF/DOCX that is not a product-path input. The right answer is a **hybrid**: native wizard for
xlsx/csv, a convert/exclude lane for the rest, and a **minimum contract** (not a rigid template).

## 1 · What the real folder actually contains (measured)
426 files, named `{projectNo}-Contacts.{ext}`: **238 xlsx · 154 pdf · 26 docx · 8 csv.**

Ran the pipeline over the **246 xlsx+csv**:

| Bucket | Count | Meaning |
|---|---:|---|
| Parsed OK | 219 | real spreadsheets we could open |
| **Auto-mappable, 0 clicks** | **173** | header detected + email column mapped (incl. Google exports) |
| Needs manual mapping | 38 | header ambiguous / email in body not in a clear column |
| Headerless email lists | 14 | bare email column / list — email-only import |
| Non-contact sheets | 8 | opened fine but no contacts (e.g. an elevations/levels table mislabeled `-Contacts`) |
| **Unreadable as xlsx** | **27** | extension lies — see below |

**The 27 "xlsx" that aren't xlsx** (extensions lie — this is a data-quality finding, not a parser bug):
15 are **old `.xls`** (OLE2); 3 are **real xlsx** openpyxl choked on (need a tolerant reader);
4 are **images** (2 PNG, 2 JPEG) renamed `.xlsx`; 2 are **HTML/XML** saved as `.xlsx`; 1 is a
**draw.io diagram** (`<mxfile>`); 2 are **text/binary**. → ~8 of these are genuinely not contact data.

### Volume behind the files
**9,576 contact rows · 5,625 distinct emails · 1,279 distinct company domains (≈ orgs) · 477 personal
emails.** Field presence across parsed files: email 173, phone 171, company 164, contact-name 158,
mobile 126, **discipline (תחום) 103**, role 82, address 81, note 11.

### Why the two structural rules are non-negotiable
**408 cells hold more than one email** (space/`;`/newline-separated) → without a **split** rule, 408+
contacts silently vanish. **2,079 rows have a blank company under a filled one** (company stated once,
blank for its people) → without a **forward-fill** rule, 2,079 rows attach to the wrong / no org. These
two rules alone touch ~2,500 rows; skipping them makes the import materially wrong.

## 2 · Coverage math (what "support the variety" costs)
- **0-click auto:** 173 / 246 = **70%** of xlsx+csv.
- **Wizard-ingestible** (auto + manual + headerless): 225 / 246 = **91%**.
- **+ old `.xls` convert** (client re-save, or a one-time LibreOffice-headless pass) + tolerant reader
  for the 3 zip files: → **~98%** of xlsx+csv.
- **~8 junk** (images / diagram / text mislabeled `-Contacts`): exclude, report by name.
- **PDF (154) + DOCX (26):** separate lane — convert or re-request. **Not** in the product path
  (extraction is RTL-mangled and some PDFs aren't contacts at all).

## 3 · The pipeline (6 stages)
1. **Triage + normalize by real type — never trust the extension. This is a PERMANENT product stage,
   not a one-time script** (new clients keep sending `.xls`, DOCX, PDF, and mislabeled files forever).
   Sniff magic bytes, then read with a **tolerant multi-format reader** so the user never pre-converts:
   in Node, SheetJS/`xlsx` reads **old `.xls` (OLE2), xlsx, csv, and HTML-as-xlsx natively in-process**
   (no LibreOffice, no external step); **DOCX** tables via a table extractor (`mammoth`/XML); **PDF**
   best-effort text-layer + RTL-reversal fix, low-confidence → manual/conflict lane. Only true non-data
   (PNG/JPEG/`<mxfile>` diagram/binary) is **rejected with a reason** ("this file is an image, not a
   contact sheet"). This stage catches the 27 liars AND is what makes every future upload Just Work.
2. **Grid + header detection.** For each sheet, scan the first ~12 rows; score each row by how many
   cells match the header dictionary (§4). The best row with **score ≥ 2** is the header; everything
   above it is banner (project name, edit-date, logo) and is skipped. No qualifying row → headerless
   lane (email-only or manual). Each xlsx **sheet** is graded independently (21 files are multi-sheet).
3. **Column mapping** = the header dictionary auto-suggests; the user confirms and can **save a named
   preset** (§5). First file of a shape costs one mapping; the rest reuse it.
4. **Structure inference — split & merge (§6).** Deterministic, then shown in preview.
5. **Preview + conflict.** The resolved table renders with **every inferred action marked** (inherited
   cell tinted, split email shown as chips). User overrides per row. Ambiguous rows → conflict screen.
6. **Dedup + commit.** Domain-first BP match (`BusinessPartnerDomain`) → normalized company name →
   personal-domain catalog routes free-email rows to conflict. Commit: typed org BPs + person BPs via
   `worker_of` + attach to project via `project-partner-roles` with the row's **discipline**.

## 4 · Header dictionary (validated — seed values)
Normalize both sides before compare: lowercase, strip quotes/dots/dashes/slashes/parens, remove spaces.
Match exact, then substring (len ≥ 3). Seed lists (extend as presets accumulate):

- **email** ← מייל, אימייל, דוא״ל, דואל, E-mail, E.MAIL, mail, email address
- **mobile** ← נייד, סלולרי, פלאפון, פלא׳, mobile, cell, cellular
- **phone** ← טלפון, טל׳, ט. משרד, טלפון משרד, phone, tel, landline
- **contact (name)** ← שם, איש קשר, שם איש קשר, name, contact, contact person, POC, full name
- **company** ← חברה, שם חברה, משרד, שם המשרד, company, office, firm, ארגון, גוף
- **discipline** ← תחום, מקצוע, עיסוק, discipline, field, trade   *(this is the role/discipline axis — maps straight to `project-partner-roles.discipline`)*
- **role** ← תפקיד, position, role, title
- **address** ← כתובת, address
- **note** ← הערות, הערה, notes, comment, remarks

Known template fingerprint: **Google Contacts export** (columns incl. `Name`, `Given Name`,
`Group Membership`, `E-mail 1 - Value`) → auto-recognized, mapped without asking.

## 5 · Presets / shape signatures — how many mappings the client really needs
A file's **shape signature** = `(sorted set of mapped fields, multi-sheet?, is-google?)`. Measured:
**72 unique shapes**, but a **long tail** — the top ~12 shapes cover the majority. Seeding **~12–15
presets** (the common column sets below) makes most files 0-click; the rest cost one mapping each,
saved for reuse. Top real shapes:

```
company, contact, email, phone, role
company, contact, discipline, email, mobile, phone
address, company, contact, discipline, mobile, phone
address, company, contact, discipline, email, mobile, phone
address, company, discipline, email, phone
contact, email, mobile, phone
```

## 6 · Split & merge — the exact rules (answers "how do we know")
The intelligence is in **field-type validators + a mandatory preview**, never in guessing the whole file.

**SPLIT — only a field whose type has a grammar we can validate.**
- A cell mapped to **email** containing a delimiter (whitespace / `,` / `;` / newline) where **every
  piece independently matches the email regex** → split. (One piece fails → no split; the whole cell
  goes to conflict.) *(408 cells in the real data.)*
- Same for **phone**: split on delimiter only when each piece matches a phone pattern; classify `05x`→
  mobile, area-code→landline. If a single `phone` column mixes both, split by pattern.
- **Never split** name / company / free text — no validator, so no split.

**MERGE / FORWARD-FILL — only by position, only on grouping columns.**
- For **company** (and **discipline**): a **blank** cell whose column was **filled in a row above**,
  where the current row still carries contact data (email/phone/name) → **inherit the value from
  above**. Reconstructs "company once, blanks for its people." *(2,079 rows.)*
- Stop-fill on a new non-blank value; never fill across a blank separator row that has no contact data.
- Every inherited cell is **tinted in preview** so the user sees and can override it.

**Merge two source columns → one field** (e.g. separate `נייד` + `טלפון`): keep both as mobile + phone;
only collapse to one when the mapping says so.

## 7 · Minimum contract (instead of a rigid template)
A row is importable if it has **a name AND (an email OR a phone)**, plus ideally a **company** and
**discipline**. Email is the identity key (present in ~all files). Everything else the mapping fills.
This is a **floor**, not a format — give it to the client as "any sheet that clears this bar imports."

## 8 · Scope — permanent product capability vs one-time backlog
The format variety is **not** a migration quirk — new clients send the same mix forever. So format
handling lives **inside the product** (Stage 1, §3), not in a throwaway script. Split the work by
*permanence*, not by *format*:

**Permanent, in-product (the wizard's normalize stage — always on):**
- **`.xls` + xlsx + csv + HTML-as-xlsx** → one tolerant reader (SheetJS) in-process. No convert step,
  no LibreOffice. This alone takes the real folder to **~98%** and covers all future uploads of these.
- **DOCX** → table extractor in the same stage (26 files today; recurring for future clients).
- **PDF** → best-effort text-layer + RTL fix; on low confidence, route to the manual/conflict lane
  rather than dropping it. Permanent, but flagged lower-confidence (never silently trusted).
- **Reject + report** true non-data (images / draw.io / binary) with a human-readable reason.

**One-time (backlog seeding only):** running this *same* pipeline once over the existing 426-file
folder to populate the system. The only thing that's one-off is *this historical batch*, not any code.

**Still worth a client ask (not a blocker):** encourage new uploads as xlsx/csv and PDF only as a last
resort — it raises the 0-click rate — but the pipeline no longer *depends* on the client reformatting.

## 9 · Acceptance targets (for the build)
- **≥ 70%** of real contact spreadsheets map at **0 clicks** (measured baseline: 70%).
- **100%** of split & forward-fill actions are visible in preview before commit; **0** silent transforms.
- Seed **~12–15 presets**; a new shape costs exactly one saved mapping.
- Import is **idempotent** (re-running a file is a no-op) and writes an import-history summary.
- Triage **rejects non-spreadsheets by real type** with a human-readable reason (never a stack trace).
- The normalize stage reads `.xls`/xlsx/csv/HTML/DOCX **in-process** (no external converter), so ingest
  works the same for the historical backlog and for every future client upload — **~98%** of the real
  spreadsheet folder, no manual pre-conversion.

---

*Methodology 2026-08-13, validated on 246 real xlsx/csv (9,576 contact rows). Per-file data in
`docs/bm2/import-analysis/per-file-analysis.csv`. Feeds Phase D of `bp-ops-surfaces.md`.*
