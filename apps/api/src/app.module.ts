import { Module, type MiddlewareConsumer, type NestModule, type OnModuleInit } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { FoundationModule } from "./foundation/foundation.module";
import { PrivilegedDatabaseModule } from "./common/privileged-database.module";
import { ObservabilityModule } from "./observability/observability.module";
import { MetricsService } from "./observability/metrics.service";
import { ReplicaRouterService } from "./foundation/replica-router.service";
import { MetricsMiddleware } from "./observability/metrics.middleware";
import { IntegrityModule } from "./integrity/integrity.module";
import { LmsModule } from "./lms/lms.module";
import { GradebookModule } from "./gradebook/gradebook.module";
import { ParentModule } from "./parent/parent.module";
import { WorkflowModule } from "./workflow/workflow.module";
import { SisModule } from "./sis/sis.module";
import { AttendanceModule } from "./attendance/attendance.module";
import { NotificationModule } from "./notifications/notification.module";
import { FeesModule } from "./fees/fees.module";
import { BillingModule } from "./billing/billing.module";
import { MaintenanceModule } from "./maintenance/maintenance.module";
import { JobRunsModule } from "./maintenance/job-runs.module";
import { RequestContextMiddleware } from "./auth/request-context.middleware";
import { DocumentsModule } from "./documents/documents.module";
import { BrandingModule } from "./branding/branding.module";
import { TimetableModule } from "./timetable/timetable.module";
import { SearchModule } from "./search/search.module";
import { MeetingModule } from "./meeting/meeting.module";
import { ExamModule } from "./exam/exam.module";
import { FeedbackModule } from "./feedback/feedback.module";
import { ApprovalsModule } from "./approvals/approvals.module";
import { SecurityModule } from "./security/security.module";
import { AnalyticsModule } from "./analytics/analytics.module";
import { PrivacyModule } from "./privacy/privacy.module";
import { CommunicationModule } from "./communication/communication.module";
import { ReportCardModule } from "./reportcards/reportcard.module";
import { HrModule } from "./hr/hr.module";
import { AdminModule } from "./admin/admin.module";
import { DashboardModule } from "./dashboard/dashboard.module";
import { OperatorModule } from "./operator/operator.module";
import { ScholarshipModule } from "./scholarship/scholarship.module";
import { AdmissionsModule } from "./admissions/admissions.module";
import { PublicModule } from "./public/public.module";
import { DirectoryModule } from "./directory/directory.module";
import { AnnouncementsModule } from "./announcements/announcements.module";
import { HostelModule } from "./hostel/hostel.module";
import { TransportModule } from "./transport/transport.module";
import { LibraryModule } from "./library/library.module";
import { GroupModule } from "./group/group.module";
import { CbtModule } from "./cbt/cbt.module";
import { LegalModule } from "./legal/legal.module";
import { TaskModule } from "./task/task.module";
import { PollModule } from "./poll/poll.module";
import { DiscussionModule } from "./discussion/discussion.module";
import { DisciplineModule } from "./discipline/discipline.module";
import { CertificateModule } from "./certificate/certificate.module";
import { AlumniModule } from "./alumni/alumni.module";
import { FormModule } from "./form/form.module";
import { GameModule } from "./game/game.module";
import { GameSocketModule } from "./game-socket/game-socket.module";
import { HealthController } from "./health.controller";

@Module({
  imports: [
    // Redis connection for BullMQ (notifications, reports, integrity jobs).
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST ?? "127.0.0.1",
        port: Number(process.env.REDIS_PORT ?? 6379),
        // Set only when ElastiCache transit encryption + auth are enabled. An
        // empty REDIS_TLS leaves both off for the local/dev Redis.
        ...(process.env.REDIS_PASSWORD
          ? { password: process.env.REDIS_PASSWORD }
          : {}),
        ...(process.env.REDIS_TLS === "true" ? { tls: {} } : {}),
      },
    }),
    ObservabilityModule,
    FoundationModule,
    PrivilegedDatabaseModule,
    IntegrityModule,
    LmsModule,
    GradebookModule,
    ParentModule,
    WorkflowModule,
    SisModule,
    NotificationModule,
    AttendanceModule,
    FeesModule,
    BillingModule,
    DocumentsModule,
    BrandingModule,
    TimetableModule,
    SearchModule,
    MeetingModule,
    ExamModule,
    FeedbackModule,
    ApprovalsModule,
    SecurityModule,
    AnalyticsModule,
    PrivacyModule,
    CommunicationModule,
    ReportCardModule,
    HrModule,
    AdminModule,
    DashboardModule,
    OperatorModule,
    ScholarshipModule,
    AdmissionsModule,
    PublicModule,
    DirectoryModule,
    AnnouncementsModule,
    HostelModule,
    TransportModule,
    LibraryModule,
    GroupModule,
    CbtModule,
    LegalModule,
    TaskModule,
    PollModule,
    DiscussionModule,
    DisciplineModule,
    CertificateModule,
    AlumniModule,
    FormModule,
    GameModule,
    GameSocketModule,
    MaintenanceModule,
    JobRunsModule,
  ],
  controllers: [HealthController],
})
export class AppModule implements NestModule, OnModuleInit {
  constructor(
    private readonly metrics: MetricsService,
    private readonly replicaRouter: ReplicaRouterService,
  ) {}

  /**
   * Publish each read-routing decision to /metrics.
   *
   * Wired HERE, where both modules already meet, rather than inside either one.
   * The router must not depend on the observability stack — it sits on the path
   * of every read, and a metrics import there is a module edge maintained for
   * ever; ObservabilityModule must not depend on the foundation either, or its
   * DI smoke test can no longer stand the module up alone, which is the whole
   * point of that test. The router offers a callback and this is its one caller.
   */
  onModuleInit(): void {
    this.replicaRouter.setObserver(({ primary, reason, lagSeconds }) =>
      this.metrics.observeReadRouting(primary, reason, lagSeconds),
    );
  }

  // Per-request prom-client metrics on EVERY route (records on response finish, so
  // it sees the final status + the matched principal). Request LOGGING is handled
  // automatically by nestjs-pino (ObservabilityModule).
  configure(consumer: MiddlewareConsumer): void {
    // RequestContext FIRST: it opens the AsyncLocalStorage store that the
    // PermissionGuard fills with the real actor when impersonating, and that
    // AuditLogService reads. Middleware wraps next(), which is what makes the
    // store propagate through the request's whole async continuation.
    consumer.apply(RequestContextMiddleware, MetricsMiddleware).forRoutes("*");
  }
}
