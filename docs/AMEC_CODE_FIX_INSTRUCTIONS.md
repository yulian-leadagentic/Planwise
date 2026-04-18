# AMEC — Code Fix Instructions

> Take this document to your coding session. Follow steps in order.
> Each step is self-contained and testable before moving to the next.

---

## Pre-Flight Checklist

Before starting, confirm your current stack:
- [ ] NestJS backend with Prisma ORM
- [ ] React frontend with TypeScript
- [ ] MySQL database
- [ ] The app runs and the existing tables exist

---

## PHASE 1: Database Schema Changes

### Step 1.1 — Create new tables

Add these NEW tables to your Prisma schema. Do NOT touch existing tables yet.

```prisma
// ──────────────────────────────────────
// NEW: Service Types (managed list)
// ──────────────────────────────────────
model ServiceType {
  id        Int      @id @default(autoincrement())
  name      String   @unique @db.VarChar(100)
  code      String?  @db.VarChar(20)
  color     String?  @db.VarChar(7)
  sortOrder Int      @default(0) @map("sort_order")
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  zoneServiceTypes  ZoneServiceType[]
  tasks             Task[]
  templateTasks     TemplateTask[]
  templateZoneTasks TemplateZoneTask[]

  @@map("service_types")
}

// ──────────────────────────────────────
// NEW: Zone ↔ Service Type junction
// ──────────────────────────────────────
model ZoneServiceType {
  id            Int      @id @default(autoincrement())
  zoneId        Int      @map("zone_id")
  serviceTypeId Int      @map("service_type_id")
  sortOrder     Int      @default(0) @map("sort_order")
  createdAt     DateTime @default(now()) @map("created_at")

  zone        Zone        @relation(fields: [zoneId], references: [id], onDelete: Cascade)
  serviceType ServiceType @relation(fields: [serviceTypeId], references: [id])

  @@unique([zoneId, serviceTypeId])
  @@map("zone_service_types")
}

// ──────────────────────────────────────
// NEW: Phases (managed list)
// ──────────────────────────────────────
model Phase {
  id        Int      @id @default(autoincrement())
  name      String   @unique @db.VarChar(100)
  sortOrder Int      @default(0) @map("sort_order")
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  tasks             Task[]
  templateTasks     TemplateTask[]
  templateZoneTasks TemplateZoneTask[]

  @@map("phases")
}

// ──────────────────────────────────────
// NEW: Template Zone Tasks (for combined templates)
// ──────────────────────────────────────
model TemplateZoneTask {
  id                  Int      @id @default(autoincrement())
  templateZoneId      Int      @map("template_zone_id")
  serviceTypeId       Int?     @map("service_type_id")
  code                String   @db.VarChar(50)
  name                String   @db.VarChar(255)
  description         String?  @db.Text
  defaultBudgetHours  Decimal? @map("default_budget_hours") @db.Decimal(10, 2)
  defaultBudgetAmount Decimal? @map("default_budget_amount") @db.Decimal(14, 2)
  defaultPriority     TaskPriority @default(medium) @map("default_priority")
  phaseId             Int?     @map("phase_id")
  sortOrder           Int      @default(0) @map("sort_order")
  createdAt           DateTime @default(now()) @map("created_at")

  templateZone TemplateZone @relation(fields: [templateZoneId], references: [id], onDelete: Cascade)
  serviceType  ServiceType? @relation(fields: [serviceTypeId], references: [id])
  phase        Phase?       @relation(fields: [phaseId], references: [id])

  @@map("template_zone_tasks")
}
```

### Step 1.2 — Modify the zones table

Add `zone_type` ENUM column and remove the foreign key to label_types/node_types if it exists.

```prisma
enum ZoneType {
  site
  building
  level
  zone
  area
  section
  wing
  floor
}

model Zone {
  id           Int       @id @default(autoincrement())
  projectId    Int       @map("project_id")
  parentId     Int?      @map("parent_id")
  zoneType     ZoneType  @default(zone) @map("zone_type")  // ADD THIS
  name         String    @db.VarChar(255)
  code         String?   @db.VarChar(50)
  areaSqm      Decimal?  @map("area_sqm") @db.Decimal(10, 2)
  path         String    @db.VarChar(1000)
  depth        Int       @default(0)
  sortOrder    Int       @default(0) @map("sort_order")
  description  String?   @db.Text
  isTypical    Boolean   @default(false) @map("is_typical")
  typicalCount Int       @default(1) @map("typical_count")
  createdAt    DateTime  @default(now()) @map("created_at")
  updatedAt    DateTime  @updatedAt @map("updated_at")
  deletedAt    DateTime? @map("deleted_at")

  project          Project           @relation(fields: [projectId], references: [id])
  parent           Zone?             @relation("ZoneTree", fields: [parentId], references: [id])
  children         Zone[]            @relation("ZoneTree")
  tasks            Task[]
  zoneServiceTypes ZoneServiceType[]
  // REMOVE: nodeTypeId / labelTypeId field and relation if they exist

  @@unique([projectId, name, deletedAt]) // zone name unique per project
  @@map("zones")
}
```

### Step 1.3 — Modify/Create the tasks table

If you currently have a table called `tasks`, `assignments`, or `services` — rename it to `tasks` and update the columns. If it doesn't exist, create it.

```prisma
enum TaskStatus {
  not_started
  in_progress
  in_review
  completed
  on_hold
  cancelled
}

enum TaskPriority {
  low
  medium
  high
  critical
}

model Task {
  id                Int         @id @default(autoincrement())
  zoneId            Int         @map("zone_id")
  projectId         Int         @map("project_id")
  serviceTypeId     Int?        @map("service_type_id")  // NULL = directly on zone
  code              String      @db.VarChar(50)
  name              String      @db.VarChar(255)
  description       String?     @db.Text
  budgetHours       Decimal?    @map("budget_hours") @db.Decimal(10, 2)
  budgetAmount      Decimal?    @map("budget_amount") @db.Decimal(14, 2)
  phaseId           Int?        @map("phase_id")
  status            TaskStatus  @default(not_started)
  priority          TaskPriority @default(medium)
  completionPct     Int         @default(0) @map("completion_pct")
  startDate         DateTime?   @map("start_date") @db.Date
  endDate           DateTime?   @map("end_date") @db.Date
  isArchived        Boolean     @default(false) @map("is_archived")
  createdBy         Int         @map("created_by")
  createdAt         DateTime    @default(now()) @map("created_at")
  updatedAt         DateTime    @updatedAt @map("updated_at")
  deletedAt         DateTime?   @map("deleted_at")

  zone        Zone         @relation(fields: [zoneId], references: [id], onDelete: Cascade)
  project     Project      @relation(fields: [projectId], references: [id])
  serviceType ServiceType? @relation(fields: [serviceTypeId], references: [id])
  phase       Phase?       @relation(fields: [phaseId], references: [id])
  creator     User         @relation("TaskCreator", fields: [createdBy], references: [id])
  assignees   TaskAssignee[]
  comments    TaskComment[]
  timeEntries TimeEntry[]

  @@index([zoneId])
  @@index([projectId])
  @@index([serviceTypeId])
  @@index([status])
  @@map("tasks")
}

model TaskAssignee {
  id         Int       @id @default(autoincrement())
  taskId     Int       @map("task_id")
  userId     Int       @map("user_id")
  role       String?   @db.VarChar(50)
  hourlyRate Decimal?  @map("hourly_rate") @db.Decimal(10, 2)
  startDate  DateTime? @map("start_date") @db.Date
  endDate    DateTime? @map("end_date") @db.Date
  createdAt  DateTime  @default(now()) @map("created_at")
  updatedAt  DateTime  @updatedAt @map("updated_at")
  deletedAt  DateTime? @map("deleted_at")

  task Task @relation(fields: [taskId], references: [id], onDelete: Cascade)
  user User @relation(fields: [userId], references: [id])

  @@unique([taskId, userId])
  @@map("task_assignees")
}

model TaskComment {
  id        Int       @id @default(autoincrement())
  taskId    Int       @map("task_id")
  userId    Int       @map("user_id")
  parentId  Int?      @map("parent_id")
  content   String    @db.Text
  createdAt DateTime  @default(now()) @map("created_at")
  updatedAt DateTime  @updatedAt @map("updated_at")
  deletedAt DateTime? @map("deleted_at")

  task   Task         @relation(fields: [taskId], references: [id], onDelete: Cascade)
  user   User         @relation(fields: [userId], references: [id])
  parent TaskComment? @relation("CommentThread", fields: [parentId], references: [id])
  replies TaskComment[] @relation("CommentThread")

  @@index([taskId])
  @@map("task_comments")
}
```

### Step 1.4 — Modify the templates tables

```prisma
enum TemplateType {
  task_list
  zone
  combined
}

model Template {
  id          Int          @id @default(autoincrement())
  code        String       @unique @db.VarChar(50)
  name        String       @db.VarChar(255)
  type        TemplateType
  category    String?      @db.VarChar(100)
  description String?      @db.Text
  isActive    Boolean      @default(true) @map("is_active")
  usageCount  Int          @default(0) @map("usage_count")
  createdBy   Int          @map("created_by")
  createdAt   DateTime     @default(now()) @map("created_at")
  updatedAt   DateTime     @updatedAt @map("updated_at")
  deletedAt   DateTime?    @map("deleted_at")

  creator       User           @relation(fields: [createdBy], references: [id])
  templateTasks TemplateTask[]
  templateZones TemplateZone[]

  @@map("templates")
}

model TemplateTask {
  id                  Int          @id @default(autoincrement())
  templateId          Int          @map("template_id")
  serviceTypeId       Int?         @map("service_type_id")
  code                String       @db.VarChar(50)
  name                String       @db.VarChar(255)
  description         String?      @db.Text
  defaultBudgetHours  Decimal?     @map("default_budget_hours") @db.Decimal(10, 2)
  defaultBudgetAmount Decimal?     @map("default_budget_amount") @db.Decimal(14, 2)
  defaultPriority     TaskPriority @default(medium) @map("default_priority")
  phaseId             Int?         @map("phase_id")
  sortOrder           Int          @default(0) @map("sort_order")
  createdAt           DateTime     @default(now()) @map("created_at")

  template    Template     @relation(fields: [templateId], references: [id], onDelete: Cascade)
  serviceType ServiceType? @relation(fields: [serviceTypeId], references: [id])
  phase       Phase?       @relation(fields: [phaseId], references: [id])

  @@map("template_tasks")
}

model TemplateZone {
  id                     Int       @id @default(autoincrement())
  templateId             Int       @map("template_id")
  parentId               Int?      @map("parent_id")
  zoneType               ZoneType  @default(zone) @map("zone_type")
  name                   String    @db.VarChar(255)
  code                   String?   @db.VarChar(50)
  isTypical              Boolean   @default(false) @map("is_typical")
  typicalCount           Int       @default(1) @map("typical_count")
  sortOrder              Int       @default(0) @map("sort_order")
  linkedTaskTemplateId   Int?      @map("linked_task_template_id")
  createdAt              DateTime  @default(now()) @map("created_at")

  template          Template          @relation(fields: [templateId], references: [id], onDelete: Cascade)
  parent            TemplateZone?     @relation("TemplateZoneTree", fields: [parentId], references: [id])
  children          TemplateZone[]    @relation("TemplateZoneTree")
  linkedTaskTemplate Template?        @relation("LinkedTaskTemplate", fields: [linkedTaskTemplateId], references: [id])
  templateZoneTasks TemplateZoneTask[]

  @@map("template_zones")
}
```

### Step 1.5 — Update time_entries

Make sure the time_entries table has `task_id` (not `assignment_id` or `service_id`):

```prisma
model TimeEntry {
  id          Int       @id @default(autoincrement())
  userId      Int       @map("user_id")
  timeClockId Int?      @map("time_clock_id")
  projectId   Int?      @map("project_id")
  taskId      Int?      @map("task_id")        // ← must be this name
  date        DateTime  @db.Date
  minutes     Int
  note        String?   @db.Text
  isBillable  Boolean   @default(true) @map("is_billable")
  createdAt   DateTime  @default(now()) @map("created_at")
  updatedAt   DateTime  @updatedAt @map("updated_at")
  deletedAt   DateTime? @map("deleted_at")

  user      User       @relation(fields: [userId], references: [id])
  timeClock TimeClock? @relation(fields: [timeClockId], references: [id])
  project   Project?   @relation(fields: [projectId], references: [id])
  task      Task?      @relation(fields: [taskId], references: [id])

  @@index([userId, date])
  @@index([taskId])
  @@index([projectId])
  @@map("time_entries")
}
```

### Step 1.6 — Delete unused tables/models

Remove these from the Prisma schema if they exist:
- `NodeType` / `LabelType` (replaced by `zone_type` ENUM)
- `CompletionRate` (replaced by `completion_pct` on tasks)
- `ServiceCategory` (replaced by `ServiceType`)
- `ServicePhase` (replaced by `Phase`)
- `Service` / `Deliverable` (replaced by `Task`)
- `PasswordReset` (replaced by OTP fields on users)

### Step 1.7 — Seed data

Create a seed script that inserts default data:

```typescript
// prisma/seed.ts

import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  // Service Types
  const serviceTypes = [
    { name: 'BIM Coordination', code: 'BIM', color: '#3B82F6', sortOrder: 1 },
    { name: 'MEP', code: 'MEP', color: '#10B981', sortOrder: 2 },
    { name: 'Structural', code: 'STR', color: '#EF4444', sortOrder: 3 },
    { name: 'Architecture', code: 'ARCH', color: '#8B5CF6', sortOrder: 4 },
    { name: 'Infrastructure', code: 'INFRA', color: '#F59E0B', sortOrder: 5 },
    { name: 'Fire Protection', code: 'FIRE', color: '#DC2626', sortOrder: 6 },
    { name: 'Acoustics', code: 'ACO', color: '#06B6D4', sortOrder: 7 },
  ];
  for (const st of serviceTypes) {
    await prisma.serviceType.upsert({
      where: { name: st.name },
      update: st,
      create: st,
    });
  }

  // Phases
  const phases = [
    { name: 'Pre-Design', sortOrder: 1 },
    { name: 'Design', sortOrder: 2 },
    { name: 'Construction', sortOrder: 3 },
    { name: 'AFC', sortOrder: 4 },
    { name: 'Handover', sortOrder: 5 },
    { name: 'Maintenance', sortOrder: 6 },
  ];
  for (const p of phases) {
    await prisma.phase.upsert({
      where: { name: p.name },
      update: p,
      create: p,
    });
  }

  // Project Types
  const projectTypes = [
    { name: 'BIM Coordination' },
    { name: 'BIM Management' },
    { name: 'MEP Coordination' },
    { name: 'Infrastructure' },
    { name: 'Buildings' },
    { name: 'Roads' },
    { name: 'Software' },
    { name: 'Mixed' },
  ];
  for (const pt of projectTypes) {
    await prisma.projectType.upsert({
      where: { name: pt.name },
      update: pt,
      create: pt,
    });
  }

  console.log('Seed complete');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
```

### Step 1.8 — Run migration

```bash
npx prisma migrate dev --name v8-zone-servicetype-task
npx prisma db seed
```

---

## PHASE 2: Backend — New Modules

### Step 2.1 — Service Types module

Create `src/modules/service-types/`:

**service-types.controller.ts** — 4 endpoints:
```
GET    /api/v1/service-types          → findAll()
POST   /api/v1/service-types          → create(dto)     [Admin, Manager]
PATCH  /api/v1/service-types/:id      → update(id, dto) [Admin, Manager]
DELETE /api/v1/service-types/:id      → remove(id)      [Admin] — only if no tasks reference it
```

**DTOs:**
```typescript
// create-service-type.dto.ts
export class CreateServiceTypeDto {
  @IsString() @MaxLength(100)
  name: string;

  @IsOptional() @IsString() @MaxLength(20)
  code?: string;

  @IsOptional() @IsString() @Matches(/^#[0-9A-Fa-f]{6}$/)
  color?: string;

  @IsOptional() @IsInt()
  sortOrder?: number;
}
```

**Service logic:**
- `findAll()`: return all, ordered by sortOrder
- `create()`: check name unique, create
- `update()`: check name unique if changed, update
- `remove()`: check `SELECT COUNT(*) FROM tasks WHERE service_type_id = ?` — if > 0, throw `BadRequestException('Cannot delete: used by N tasks')`

---

### Step 2.2 — Phases module

Create `src/modules/phases/` — exact same pattern as service-types. 4 endpoints, same CRUD logic. Check task references before delete.

---

### Step 2.3 — Tasks module (rename from whatever exists)

If you have `assignments`, `services`, or `tasks` module, rename it. If none exists, create from scratch.

Create `src/modules/tasks/`:

**tasks.controller.ts** — endpoints:
```
GET    /api/v1/tasks                   → findAll(filters)    [All]
GET    /api/v1/tasks/mine              → findMine(userId)    [All]
POST   /api/v1/tasks                   → create(dto)         [Coordinator+]
GET    /api/v1/tasks/:id               → findOne(id)         [All]
PATCH  /api/v1/tasks/:id               → update(id, dto)     [Coordinator+]
DELETE /api/v1/tasks/:id               → remove(id)          [Coordinator+]

POST   /api/v1/tasks/:id/assignees     → addAssignee(dto)    [Coordinator+]
DELETE /api/v1/task-assignees/:id       → removeAssignee(id)  [Coordinator+]

GET    /api/v1/tasks/:id/comments      → getComments(id)     [All]
POST   /api/v1/tasks/:id/comments      → addComment(dto)     [All]
PATCH  /api/v1/comments/:id            → updateComment(dto)  [Own only]
DELETE /api/v1/comments/:id            → removeComment(id)   [Own + Admin]
```

**create-task.dto.ts:**
```typescript
export class CreateTaskDto {
  @IsInt()
  zoneId: number;

  @IsOptional() @IsInt()
  serviceTypeId?: number;  // null = directly on zone

  @IsString() @MaxLength(50)
  code: string;

  @IsString() @MaxLength(255)
  name: string;

  @IsOptional() @IsString()
  description?: string;

  @IsOptional() @IsNumber() @Min(0)
  budgetHours?: number;

  @IsOptional() @IsNumber() @Min(0)
  budgetAmount?: number;

  @IsOptional() @IsInt()
  phaseId?: number;

  @IsOptional() @IsEnum(TaskPriority)
  priority?: TaskPriority;
}
```

**tasks.service.ts** — key methods:

```typescript
async create(dto: CreateTaskDto, userId: number) {
  // 1. Verify zone exists and get its projectId
  const zone = await this.prisma.zone.findUniqueOrThrow({ where: { id: dto.zoneId } });

  // 2. If serviceTypeId provided, ensure zone_service_types row exists
  if (dto.serviceTypeId) {
    await this.prisma.zoneServiceType.upsert({
      where: { zoneId_serviceTypeId: { zoneId: dto.zoneId, serviceTypeId: dto.serviceTypeId } },
      create: { zoneId: dto.zoneId, serviceTypeId: dto.serviceTypeId },
      update: {},
    });
  }

  // 3. Create the task
  return this.prisma.task.create({
    data: {
      ...dto,
      projectId: zone.projectId,
      createdBy: userId,
    },
    include: { serviceType: true, phase: true, assignees: { include: { user: true } } },
  });
}

async findAllByZone(zoneId: number) {
  // Returns tasks grouped by service type
  const tasks = await this.prisma.task.findMany({
    where: { zoneId, deletedAt: null, isArchived: false },
    include: {
      serviceType: true,
      phase: true,
      assignees: { include: { user: true }, where: { deletedAt: null } },
    },
    orderBy: [{ serviceTypeId: 'asc' }, { sortOrder: 'asc' }],
  });

  // Group by service type
  const grouped = new Map<number | null, { serviceType: ServiceType | null; tasks: Task[] }>();
  for (const task of tasks) {
    const key = task.serviceTypeId;
    if (!grouped.has(key)) {
      grouped.set(key, { serviceType: task.serviceType, tasks: [] });
    }
    grouped.get(key)!.tasks.push(task);
  }

  return Array.from(grouped.values());
}

async findMine(userId: number) {
  // All tasks where user is an assignee, grouped by project then zone
  return this.prisma.task.findMany({
    where: {
      deletedAt: null,
      isArchived: false,
      assignees: { some: { userId, deletedAt: null } },
    },
    include: {
      zone: true,
      project: true,
      serviceType: true,
      assignees: { include: { user: true }, where: { deletedAt: null } },
    },
    orderBy: [{ projectId: 'asc' }, { zoneId: 'asc' }],
  });
}
```

---

### Step 2.4 — Zone operations (apply template, duplicate)

Add to your existing zones controller/service:

**New endpoints:**
```
POST /api/v1/zones/:id/apply-task-template   → applyTaskTemplate(zoneId, { templateId })
POST /api/v1/zones/:id/duplicate             → duplicateZone(zoneId, { newName })
```

**zones.service.ts** — new methods:

```typescript
async applyTaskTemplate(zoneId: number, templateId: number, userId: number) {
  const zone = await this.prisma.zone.findUniqueOrThrow({ where: { id: zoneId } });
  const template = await this.prisma.template.findUniqueOrThrow({
    where: { id: templateId },
    include: { templateTasks: { include: { serviceType: true } } },
  });

  // Transaction: create zone_service_types + tasks
  return this.prisma.$transaction(async (tx) => {
    const createdTasks = [];

    for (const tt of template.templateTasks) {
      // 1. Ensure zone_service_types exists for this service type
      if (tt.serviceTypeId) {
        await tx.zoneServiceType.upsert({
          where: { zoneId_serviceTypeId: { zoneId, serviceTypeId: tt.serviceTypeId } },
          create: { zoneId, serviceTypeId: tt.serviceTypeId },
          update: {},
        });
      }

      // 2. Create the task
      const task = await tx.task.create({
        data: {
          zoneId,
          projectId: zone.projectId,
          serviceTypeId: tt.serviceTypeId,
          code: tt.code,
          name: tt.name,
          description: tt.description,
          budgetHours: tt.defaultBudgetHours,
          budgetAmount: tt.defaultBudgetAmount,
          phaseId: tt.phaseId,
          priority: tt.defaultPriority,
          status: 'not_started',
          createdBy: userId,
        },
      });
      createdTasks.push(task);
    }

    // 3. Increment template usage count
    await tx.template.update({
      where: { id: templateId },
      data: { usageCount: { increment: 1 } },
    });

    return createdTasks;
  });
}

async duplicateZone(zoneId: number, newName: string, userId: number) {
  const zone = await this.prisma.zone.findUniqueOrThrow({
    where: { id: zoneId },
    include: {
      tasks: { where: { deletedAt: null }, include: { serviceType: true } },
      zoneServiceTypes: true,
    },
  });

  // Check name unique within project
  const existing = await this.prisma.zone.findFirst({
    where: { projectId: zone.projectId, name: newName, deletedAt: null },
  });
  if (existing) throw new ConflictException('Zone name must be unique within project');

  return this.prisma.$transaction(async (tx) => {
    // 1. Create new zone
    const newZone = await tx.zone.create({
      data: {
        projectId: zone.projectId,
        parentId: zone.parentId,
        zoneType: zone.zoneType,
        name: newName,
        code: null,
        path: '', // will be recalculated
        depth: zone.depth,
        sortOrder: zone.sortOrder + 1,
      },
    });

    // Recalculate path
    const parent = zone.parentId
      ? await tx.zone.findUnique({ where: { id: zone.parentId } })
      : null;
    const path = parent ? `${parent.path}/${newZone.id}` : `/${newZone.id}`;
    await tx.zone.update({ where: { id: newZone.id }, data: { path } });

    // 2. Copy zone_service_types
    for (const zst of zone.zoneServiceTypes) {
      await tx.zoneServiceType.create({
        data: { zoneId: newZone.id, serviceTypeId: zst.serviceTypeId, sortOrder: zst.sortOrder },
      });
    }

    // 3. Copy all tasks (without assignees)
    for (const task of zone.tasks) {
      await tx.task.create({
        data: {
          zoneId: newZone.id,
          projectId: zone.projectId,
          serviceTypeId: task.serviceTypeId,
          code: task.code,
          name: task.name,
          description: task.description,
          budgetHours: task.budgetHours,
          budgetAmount: task.budgetAmount,
          phaseId: task.phaseId,
          priority: task.priority,
          status: 'not_started',
          completionPct: 0,
          createdBy: userId,
        },
      });
    }

    return newZone;
  });
}
```

---

### Step 2.5 — Budget summary endpoint

Add to projects controller:

```
GET /api/v1/projects/:id/budget-summary
```

**projects.service.ts:**

```typescript
async getBudgetSummary(projectId: number) {
  const project = await this.prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    include: { contracts: { where: { deletedAt: null } } },
  });

  // Total tasks budget
  const totals = await this.prisma.task.aggregate({
    where: { projectId, deletedAt: null, isArchived: false },
    _sum: { budgetHours: true, budgetAmount: true },
    _count: true,
  });

  // By zone
  const byZone = await this.prisma.$queryRaw`
    SELECT z.id, z.name, z.path, z.depth,
      COALESCE(SUM(t.budget_hours), 0) as total_hours,
      COALESCE(SUM(t.budget_amount), 0) as total_amount,
      COUNT(t.id) as task_count
    FROM zones z
    LEFT JOIN tasks t ON t.zone_id = z.id AND t.deleted_at IS NULL AND t.is_archived = false
    WHERE z.project_id = ${projectId} AND z.deleted_at IS NULL
    GROUP BY z.id ORDER BY z.path
  `;

  // By service type
  const byServiceType = await this.prisma.$queryRaw`
    SELECT st.id, st.name, st.code, st.color,
      COALESCE(SUM(t.budget_hours), 0) as total_hours,
      COALESCE(SUM(t.budget_amount), 0) as total_amount,
      COUNT(t.id) as task_count
    FROM tasks t
    LEFT JOIN service_types st ON st.id = t.service_type_id
    WHERE t.project_id = ${projectId} AND t.deleted_at IS NULL AND t.is_archived = false
    GROUP BY st.id
  `;

  // By phase
  const byPhase = await this.prisma.$queryRaw`
    SELECT p.id, p.name,
      COALESCE(SUM(t.budget_hours), 0) as total_hours,
      COALESCE(SUM(t.budget_amount), 0) as total_amount
    FROM tasks t
    LEFT JOIN phases p ON p.id = t.phase_id
    WHERE t.project_id = ${projectId} AND t.deleted_at IS NULL AND t.is_archived = false
    GROUP BY p.id
  `;

  // Contract comparison
  const contractTotal = project.contracts.reduce(
    (sum, c) => sum + Number(c.totalAmount || 0), 0
  );

  return {
    project: { id: project.id, name: project.name, budget: project.budget },
    totals: {
      hours: Number(totals._sum.budgetHours || 0),
      amount: Number(totals._sum.budgetAmount || 0),
      taskCount: totals._count,
    },
    byZone,
    byServiceType,
    byPhase,
    comparison: {
      contractAmount: contractTotal,
      tasksTotal: Number(totals._sum.budgetAmount || 0),
      remaining: contractTotal - Number(totals._sum.budgetAmount || 0),
      remainingPct: contractTotal > 0
        ? ((contractTotal - Number(totals._sum.budgetAmount || 0)) / contractTotal * 100).toFixed(1)
        : null,
      status: Number(totals._sum.budgetAmount || 0) > contractTotal ? 'over_budget' : 'within_budget',
    },
  };
}
```

---

### Step 2.6 — Templates module

Create `src/modules/templates/`:

**templates.controller.ts:**
```
GET    /api/v1/templates              → findAll(?type=task_list|zone|combined)
POST   /api/v1/templates              → create(dto)
GET    /api/v1/templates/:id          → findOne(id) — includes tasks/zones
PATCH  /api/v1/templates/:id          → update(id, dto)
DELETE /api/v1/templates/:id          → remove(id) — only if usageCount = 0
POST   /api/v1/templates/:id/duplicate → duplicate(id, { newName, newCode })
```

**create-template.dto.ts:**
```typescript
export class CreateTemplateDto {
  @IsString() @MaxLength(50)
  code: string;

  @IsString() @MaxLength(255)
  name: string;

  @IsEnum(TemplateType)
  type: TemplateType;

  @IsOptional() @IsString() @MaxLength(100)
  category?: string;

  @IsOptional() @IsString()
  description?: string;

  @IsOptional() @IsArray() @ValidateNested({ each: true })
  @Type(() => CreateTemplateTaskDto)
  tasks?: CreateTemplateTaskDto[];  // for task_list type

  @IsOptional() @IsArray() @ValidateNested({ each: true })
  @Type(() => CreateTemplateZoneDto)
  zones?: CreateTemplateZoneDto[];  // for zone and combined types
}

export class CreateTemplateTaskDto {
  @IsOptional() @IsInt()
  serviceTypeId?: number;

  @IsString() @MaxLength(50)
  code: string;

  @IsString() @MaxLength(255)
  name: string;

  @IsOptional() @IsString()
  description?: string;

  @IsOptional() @IsNumber()
  defaultBudgetHours?: number;

  @IsOptional() @IsNumber()
  defaultBudgetAmount?: number;

  @IsOptional() @IsEnum(TaskPriority)
  defaultPriority?: TaskPriority;

  @IsOptional() @IsInt()
  phaseId?: number;

  @IsOptional() @IsInt()
  sortOrder?: number;
}

export class CreateTemplateZoneDto {
  @IsEnum(ZoneType)
  zoneType: ZoneType;

  @IsString() @MaxLength(255)
  name: string;

  @IsOptional() @IsString() @MaxLength(50)
  code?: string;

  @IsOptional() @IsBoolean()
  isTypical?: boolean;

  @IsOptional() @IsInt()
  typicalCount?: number;

  @IsOptional() @IsInt()
  linkedTaskTemplateId?: number;

  @IsOptional() @IsArray() @ValidateNested({ each: true })
  @Type(() => CreateTemplateZoneDto)
  children?: CreateTemplateZoneDto[];  // recursive

  @IsOptional() @IsArray() @ValidateNested({ each: true })
  @Type(() => CreateTemplateTaskDto)
  tasks?: CreateTemplateTaskDto[];  // for combined templates
}
```

---

## PHASE 3: Frontend Changes

### Step 3.1 — Shared types (packages/shared or src/types)

Create `enums.ts`:
```typescript
export const SERVICE_TYPE_COLORS: Record<string, string> = {
  BIM: '#3B82F6',
  MEP: '#10B981',
  STR: '#EF4444',
  ARCH: '#8B5CF6',
  INFRA: '#F59E0B',
  FIRE: '#DC2626',
  ACO: '#06B6D4',
};

export const ZONE_TYPE_DISPLAY = {
  site:     { icon: 'MapPin',    label: 'Site' },
  building: { icon: 'Building2', label: 'Building' },
  level:    { icon: 'Layers',    label: 'Level' },
  zone:     { icon: 'Grid3x3',   label: 'Zone' },
  area:     { icon: 'Square',    label: 'Area' },
  section:  { icon: 'LayoutGrid',label: 'Section' },
  wing:     { icon: 'ArrowLeftRight', label: 'Wing' },
  floor:    { icon: 'Minus',     label: 'Floor' },
} as const;
```

### Step 3.2 — API layer

Create/update `src/api/tasks.api.ts`:
```typescript
export const tasksApi = {
  findAll: (params) => apiClient.get('/tasks', { params }),
  findMine: () => apiClient.get('/tasks/mine'),
  findByZone: (zoneId: number) => apiClient.get('/tasks', { params: { zoneId } }),
  create: (data) => apiClient.post('/tasks', data),
  update: (id: number, data) => apiClient.patch(`/tasks/${id}`, data),
  remove: (id: number) => apiClient.delete(`/tasks/${id}`),
  addAssignee: (taskId: number, data) => apiClient.post(`/tasks/${taskId}/assignees`, data),
  removeAssignee: (id: number) => apiClient.delete(`/task-assignees/${id}`),
  getComments: (taskId: number) => apiClient.get(`/tasks/${taskId}/comments`),
  addComment: (taskId: number, data) => apiClient.post(`/tasks/${taskId}/comments`, data),
};

export const zonesApi = {
  // ...existing zone methods...
  applyTaskTemplate: (zoneId: number, templateId: number) =>
    apiClient.post(`/zones/${zoneId}/apply-task-template`, { templateId }),
  duplicate: (zoneId: number, newName: string) =>
    apiClient.post(`/zones/${zoneId}/duplicate`, { newName }),
};

export const serviceTypesApi = {
  findAll: () => apiClient.get('/service-types'),
  create: (data) => apiClient.post('/service-types', data),
  update: (id: number, data) => apiClient.patch(`/service-types/${id}`, data),
  remove: (id: number) => apiClient.delete(`/service-types/${id}`),
};

export const phasesApi = {
  findAll: () => apiClient.get('/phases'),
  create: (data) => apiClient.post('/phases', data),
  update: (id: number, data) => apiClient.patch(`/phases/${id}`, data),
  remove: (id: number) => apiClient.delete(`/phases/${id}`),
};

export const templatesApi = {
  findAll: (type?: string) => apiClient.get('/templates', { params: { type } }),
  findOne: (id: number) => apiClient.get(`/templates/${id}`),
  create: (data) => apiClient.post('/templates', data),
  update: (id: number, data) => apiClient.patch(`/templates/${id}`, data),
  remove: (id: number) => apiClient.delete(`/templates/${id}`),
  duplicate: (id: number, data) => apiClient.post(`/templates/${id}/duplicate`, data),
};

export const budgetApi = {
  getSummary: (projectId: number) => apiClient.get(`/projects/${projectId}/budget-summary`),
};
```

### Step 3.3 — Planning tab component

Create `src/features/projects/planning-tab.tsx`:

This is the main component — zone tree on left, tasks table on right:

```
Component structure:

PlanningTab
├── ZoneTreePanel (left)
│   ├── ZoneNode (recursive)
│   └── AddZoneButton / ApplyZoneTemplateButton
├── TasksPanel (right, filtered by selected zone)
│   ├── ServiceTypeGroup (for each service type in the zone)
│   │   ├── ServiceTypeHeader (collapsible, shows service type name + color)
│   │   └── TaskRow[] (inline-editable table rows)
│   ├── UngroupedTasks (tasks with no service type)
│   ├── AddTaskButton / ApplyTaskTemplateDropdown
│   └── AssigneeCell (user search/select dropdown per task row)
└── BudgetSummaryBar (bottom)
    ├── Zone totals
    ├── Project totals
    ├── By service type breakdown
    └── Contract comparison
```

**Key behaviors:**
- Click zone in tree → right panel loads tasks for that zone, grouped by service type
- [Apply Task Template ▼] → dropdown of templates → calls `zonesApi.applyTaskTemplate(zoneId, templateId)` → reloads task list
- [+ Add Task] → empty row in table, user fills code/name/hours/amount/serviceType/phase
- [Duplicate Zone] → modal with name input → calls `zonesApi.duplicate(zoneId, newName)`
- Assignee column → each task has a user search/select → calls `tasksApi.addAssignee(taskId, { userId })`
- Budget summary bar at bottom auto-recalculates from task data

### Step 3.4 — Update sidebar navigation

```
REMOVE from sidebar:
  - Any "Label Types" / "Node Types" link
  - Any reference to old Admin config pages for categories

UPDATE Templates section:
  📐 Templates
    ├── Task Templates       → /templates?type=task_list
    ├── Zone Templates       → /templates?type=zone
    ├── Combined Templates   → /templates?type=combined
    ├── Team Templates       → /team-templates
    ├── ─────────
    ├── Service Types        → /templates/service-types
    ├── Phases               → /templates/phases
    └── Project Types        → /templates/project-types

UPDATE Admin section (simplified):
  ⚙️ Admin
    ├── Roles & Permissions
    ├── Activity Log
    ├── Clock Dashboard
    ├── Work Schedules
    └── Calendar
```

### Step 3.5 — Rename in all existing frontend files

Global find & replace across the frontend codebase:

```
File renames:
  tasks-page.tsx or assignments-page.tsx    →  keep as tasks-page.tsx
  task-detail-page.tsx                       →  keep as task-detail-page.tsx
  use-tasks.ts or use-assignments.ts         →  use-tasks.ts
  tasks.api.ts or assignments.api.ts         →  tasks.api.ts
  
Text renames in UI:
  "My Assignments"  → "My Tasks"
  "Assignment"      → "Task"
  "Service"         → depends on context:
    if it means the work item → "Task"
    if it means the category  → "Service Type"
  "Label Type"      → DELETE (no replacement)
  "Node Type"       → DELETE (no replacement)

Route renames:
  /assignments      → /tasks
  /assignments/:id  → /tasks/:id
  /services         → nothing (this path shouldn't exist)
```

---

## PHASE 4: Verification Checklist

After all changes, verify:

- [ ] `npx prisma migrate dev` runs without errors
- [ ] `npx prisma db seed` populates service_types, phases, project_types
- [ ] `GET /api/v1/service-types` returns the seeded list
- [ ] `GET /api/v1/phases` returns the seeded list
- [ ] Can create a template with tasks grouped by service types
- [ ] Can create a zone in a project
- [ ] Can apply a task template to a zone → tasks appear grouped by service type
- [ ] Can manually add a task to a zone (with or without service type)
- [ ] Can assign a user to a task
- [ ] Can duplicate a zone → new zone has same tasks, no assignees
- [ ] `GET /api/v1/projects/:id/budget-summary` returns correct totals
- [ ] Budget summary shows on planning tab
- [ ] Zone name uniqueness enforced per project
- [ ] No references to "label types" / "node types" remain in code
- [ ] Templates menu in sidebar shows all 7 sections
- [ ] Admin menu is simplified (no category/phase/type management)
