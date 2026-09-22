# Runbook — Migrating a school onto MAESTRO-SMS

**For:** whoever runs the migration — platform staff, not the school.
**Read before:** the first call with the school, not the first upload.

A migration is mostly conversation and spreadsheet work. The uploading is the
short part. This runbook is ordered the way the work actually happens.

---

## 0. The one decision everything follows from

**Migrate the operating state. Archive the history.**

Do not try to reconstruct the school's past inside the database. Load only what
the school needs in order to operate from day one, and put the past in the
Document Vault as files.

Four reasons, and the fourth should settle any argument:

1. There is **no import path** for attendance, grades or fee history. Building
   one means building it per source system.
2. Historical data is looked up, not transacted on — a transcript request, a
   receipt query. A PDF per pupil serves that.
3. It is not what makes the school operational. Nobody is blocked on last year's
   register.
4. **The fees ledger is append-only with no hard delete.** A wrong fee-history
   import cannot be cleaned up, only added to. Every correcting entry is itself
   permanent, and the school's books carry your mistake for ever.

**Cut over at a term boundary** and most of the question disappears: the old
term closes in the old system, the new term opens in this one.

If a school insists on historical fee data in the ledger, the answer is no, and
the reason above is the reason. Offer the archive instead.

---

## 1. Scope the migration (before you promise a date)

Ask for, and write down:

| Question | Why it matters |
|---|---|
| How many pupils, staff, classes? | Pupils ÷ 200 = number of upload batches |
| What system are they leaving? | Determines how bad the export will be |
| Can they export to CSV/Excel at all? | If not, this is a data-entry job, price it as one |
| Do pupils have stable admission numbers? | See §2 — this is the spine |
| What is their term boundary? | Your cutover date |
| Who is their bursar, and do they have a signed outstanding-balance list? | §7 |
| Which country? | Sets currency, timezone, calendar, payroll pack |

**Red flags that change the estimate:** no admission numbers; several
spreadsheets that disagree; guardians recorded as free text inside the pupil row
rather than as people; fee balances only in a paper ledger.

---

## 2. Fix the admission numbers FIRST

Everything joins on admission number. Guardians link by it. Later corrections
upsert on it. The roster export round-trips on it.

> Leave the column blank and the platform allocates one — after which **neither
> the guardian upload nor any later correction can name that pupil**.

So, before any upload:

1. Get the pupil list out of the old system.
2. If admission numbers exist and are unique — good, freeze them.
3. If they do not exist, or collide, **allocate them in the spreadsheet now** and
   tell the school this is their canonical list from here on.
4. Check for duplicates before you go further:

```bash
# in the shaped CSV, column 2 is admissionNumber
cut -d, -f2 students.csv | sort | uniq -d
```

Any output is a blocker. Resolve it with the school, not by guessing.

---

## 3. Shape the data — and do it yourself

**The school sends you their export. You produce the templates.** Do not send a
school a blank template and ask them to fill it in.

A school that mangles its own migration blames the product. Schools cannot
reliably do lookups across sheets, and the failure is silent — a shifted column
enrols thirty pupils into a class called `Ikeja"`. Treat migration as a service
you perform.

Download the real templates rather than hand-writing headers; they carry a
worked example and the column order is checked by the importer:

```
GET /admin/students/import/template      (perm: student.import)
GET /admin/parents/import/template       (perm: parent.import)
```

In the app: **/admin/import** and **/admin/parents**.

### Student columns

| Column | Required | Notes |
|---|---|---|
| `name` | **yes** | The only genuinely required column |
| `admissionNumber` | no, but **always supply it** | §2 |
| `class` | no | The class **NAME or CODE** as shown on the classes page, e.g. `SS3 Science A`. Not a uuid |
| `dateOfBirth` | no | `YYYY-MM-DD` |
| `gender` | no | |
| `email` | no | Blank = a sign-in identifier is generated from the name |
| `phone` | no | |
| `addressLine1`, `addressLine2` | no | |
| `city`, `state` | no, but **fill them in** | Required for a COMPLETE profile. Leave them out and the nightly SIS sweep chases those families for two facts nobody ever asked them for |

### Guardian columns

`name`, `contactEmail` (required — a guardian with no reachable address can
never get a password reset or a receipt), `phone`, `relationship`, and
`studentAdmissionNumbers` — children by admission number, **semicolon**
separated: `ADM-001;ADM-014`. `studentEmails` works too and is merged with it.

### Not importable, deliberately

**Medical records and emergency contacts.** They are encrypted at rest and
separately audited; a spreadsheet is the wrong custody for them. Plan to
re-collect them from families at the start of term — and sell that as what it
is: fresh consent and current data.

---

## 4. Build the skeleton

Order matters. Each step depends on the one above it.

1. **Provision the school.** `POST /operator/tenants` (`platform.tenants.write`
   + step-up), or approve their `/onboard` application at
   `/admin/admissions` → the operator's onboarding review.
2. **Set the region NOW** — country, timezone, currency, calendar template.
   `PUT /operator/tenants/:id/region` (`platform.tenants.region` + step-up).
   Do not leave this for later: it decides the currency every invoice is
   denominated in, the day boundary every register is filed against, and
   whether statutory payroll works at all. Correcting it afterwards moves all
   three, and realigns the calendar template only when it was never overridden.
3. **Academic session and terms**, and mark the current term.
   **Skip this and the school runs silently broken**: registers never lock, the
   register-reminder sweep skips the school every day for ever, and report cards
   have no period to scope to. It leaves almost no trace — a `skipped` count in
   an operator console the school never opens.
4. **Classes.** Must exist before the student upload, because the `class` column
   matches on name or code. `POST /classes/arms` creates a stream's arms at once.
5. **Subjects**, then attach them per class (`POST /classes/:classId/subjects/bulk`).

---

## 5. Load the people

### Students

Batches of **200 rows** (`BULK_IMPORT_MAX_ROWS`). A 900-pupil school is five
uploads.

```
POST /admin/students/import               → staged, nothing created yet
GET  /admin/students/import               → list the batches
POST /admin/students/import/:id/approve   ← A DIFFERENT PERSON
POST /admin/students/import/:id/reject    → discards the staged rows
```

**Separation of duties is enforced: the uploader cannot approve their own
batch.** Plan for two people with `student.import` — you and the school's admin
is the usual pairing, and it doubles as their first look at their own data.

Nothing exists until approval. A staged batch can be rejected freely; this is
your safety net, so **check the batch detail before approving**, not after.

**Class capacity is enforced at approval**, re-asserted inside the write
transaction. A batch that would overfill a class is refused rather than
overfilling it.

**At approval you are handed the credentials ONCE.** Each pupil gets a unique
random temporary password, returned in the approve response and offered as a
login-slips CSV. They are never stored in readable form and cannot be re-issued
in bulk. **Save that file immediately.** `passwordChangedAt` is null, so every
pupil is forced to set their own password at first sign-in.

### Guardians

After students, because they match on admission number.

```
POST /admin/parents/import   →   POST /admin/parents/import/:id/approve
```

### Staff — the gap, and how to cover it

**There is no staff import.** There is a staff roster *export*
(`GET /admin/export/staff.csv`) but nothing that reads one back.

Until that is built, staff are created one at a time:

```
POST /admin/users              (perm: rbac.manage)
POST /admin/users/:userId/roles
```

then an HR employment record per person at **/hr**. This is scriptable against
the API and that is how a school of any size should be done — but budget for it,
because it is currently the phase that does not scale.

> **Do not grant `school_admin` or `principal` casually while loading staff.**
> Nobody may remove their own managing role, and the last managing role in a
> school cannot be removed. Appointing a `junior_admin`, or stacking roles onto
> one, raises an ADMIN_APPOINTMENT approval that a different `workflow.review`
> holder must approve.

---

## 6. Correcting what you loaded

The import **upserts on admission number**, and a **blank cell never clears a
stored value**. So the correction loop is:

1. `GET /admin/export/students.csv` — the roster export round-trips the template.
2. Fix it in a spreadsheet.
3. Re-upload the same file.

A re-upload carrying only addresses will not wipe everybody's date of birth.
An update rewrites a child's record, so it still goes through maker-checker, and
the approver is shown **which fields change**.

Commas, quotes, embedded newlines, CRLF and Excel's BOM are all handled — a
quoted `"12 Main St, Ikeja"` is safe.

---

## 7. Opening balances

**Do not reconstruct invoices and payments.**

For each pupil who owes money at cutover, raise **one invoice for the net
outstanding amount**, dated the cutover, described plainly:

> Balance brought forward from [previous system] as at [date]

Then issue them together: `POST /invoices/issue-bulk`.

**Get the bursar's signature on the balance list before you load it.** You
cannot delete what you post — the ledger has no hard delete. One signed
spreadsheet, one load.

Watch the currency. An invoice carries its own, and new invoices default to the
school's — which is why §4 step 2 comes before this one.

---

## 8. Archive the history

Per pupil, upload the old system's records as a file:

```
POST /documents            → metadata (type TRANSCRIPT or OTHER)
POST /documents/:id/upload-bytes   (or the presigned URL)
POST /documents/:id/confirm
```

The vault scopes each document to that pupil and their guardians, and downloads
are audited. Confirm checks that the bytes actually arrived, that they fit, and
that they are the type claimed — an upload is a claim until the server looks at
it.

This is the deliverable that lets you say no to a fee-history import without
saying no to the school.

---

## 9. Before you hand over

Work through this with the school's admin present:

- [ ] Every pupil appears on **/students**, and the roll count matches theirs
- [ ] Classes show the right numbers; no pupil is unassigned by accident
- [ ] Guardians can see their own children, and only their own
- [ ] A teacher can open **/attendance** and take a register
- [ ] The **current term** is set, and **/analytics** shows figures for it
- [ ] Opening-balance invoices are ISSUED and total the bursar's signed figure
- [ ] The login-slips CSVs are saved and handed over securely
- [ ] Staff hold the roles they should, and **nobody holds `school_admin` who
      should not**
- [ ] Their subscription tier is right — note that a STANDARD school has no
      analytics, so the dashboard will not show those tiles at all

Then run a **parallel week**: the school keeps the old system open and does both.
It is the only way the gaps surface while there is still somebody to fix them.

---

## 10. What to build, when you have done three of these

In this order:

1. **A staff importer**, mirroring the student one. Every school has staff, and
   §5 is the phase that currently does not scale. The student import is the
   template — copy its shape, maker-checker included.
2. **An opening-balance importer** — fee item plus one invoice per pupil from a
   two-column CSV. Small, and it removes the riskiest manual step in §7.
3. **A per-source-system extraction guide.** After a few migrations you will know
   the two or three systems that dominate your market. A one-page "export these
   screens" sheet turns §1 from a conversation into an instruction.

Do the first few by hand, so the tooling is shaped by what actually hurt.

---

## Failure modes seen, and what they look like

| Symptom | Cause | Fix |
|---|---|---|
| Pupils imported with no class | `class` column held a uuid, or a name that does not match the classes page | Re-upload with the class NAME; the refusal names the value that failed |
| Guardian upload links nobody | Admission numbers blank at student import, so the platform allocated its own | Export the roster, take the allocated numbers, rebuild the guardian file |
| Address truncated, pupils in a class called `Ikeja"` | Old export not quoted — but the importer handles quoting, so suspect a hand-edited file | Re-export, do not hand-edit |
| Every family nagged for city/state | Those columns left blank | Re-upload with them filled; blank cells do not clear anything |
| Approval refused | Same person uploaded and approved | Second person with `student.import` |
| Approval refused, class full | Capacity, re-asserted in the write | Raise the capacity or split the class |
| School's dashboard shows no figures | STANDARD tier has no analytics module | Expected. Not a fault |
