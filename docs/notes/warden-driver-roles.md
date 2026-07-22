# Warden & driver roles

> Warden + driver roles with relationship-scoped hostel/transport access + module analytics

*Engineering note (project) — a point-in-time record from a build session. The durable spec is [CLAUDE.md](../../CLAUDE.md); verify details against the code before relying on them.*

---

**Warden + driver RBAC (2026-07-01).** Two NEW roles added (seed grantsByRole + demo users
`warden@`/`driver@demo.school`):
- `warden`: hostel.read + hostel.manage (+ hr.self, notification.read, message.*, event.read,
  announcement.read, task.participate). Relationship-scoped in `HostelService`: `wide(p)` =
  school_admin|principal|super_admin see ALL; a warden is confined to hostels where
  `Hostel.wardenId = p.userId` (list, rooms, allocations, fees, summary all filtered;
  `assertHostelInScope` throws 404 otherwise). A warden CANNOT create a hostel (403, admin-only)
  or reassign the warden (403).
- `driver`: transport.read only (read-only) + basic staff comms. Scoped in `TransportService`:
  a driver sees ONLY their own vehicle (`Vehicle.driverId = p.userId`), its routes
  (`route.vehicle.driverId`), and passengers. Managing is blocked by lacking transport.manage.

**Schema:** `Vehicle.driverId String?` (migration `20260725000000_vehicle_driver`). `VehicleDto`
gained `driverId`; create/updateVehicle accept it. Assign a warden in the hostel create form
(wardenId picker) and a driver in the vehicle form (driverId picker) — both fed by `/users`.

**Analytics:** `GET /hostels/summary` (HostelSummaryDto: hostels/rooms/beds/occupied/vacant/
occupancyPct) + `GET /transport/summary` (TransportSummaryDto: vehicles/routes/stops/passengers/
seats/seatsUsed) — both scoped the same way (warden→own hostel occupancy, driver→own route load).

**super_admin absolute control** is via the operator console (module on/off per school +
step-up impersonation), NOT direct hostel/transport perms — its school_id is the platform org
(no hostels/vehicles there), so granting tenant perms would be meaningless; impersonation gives
full cross-tenant control. Verified live: warden sees only their hostel, driver only their vehicle,
admin sees all, warden-create-hostel→403. 446/446 tests, typecheck 13/13.
