import { Module, type MiddlewareConsumer, type NestModule } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { FoundationModule } from "./foundation/foundation.module";
import { PrivilegedDatabaseModule } from "./common/privileged-database.module";
import { ObservabilityModule } from "./observability/observability.module";
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
import { DocumentsModule } from "./documents/documents.module";
import { BrandingModule } from "./branding/branding.module";
import { TimetableModule } from "./timetable/timetable.module";
import { SecurityModule } from "./security/security.module";
import { AnalyticsModule } from "./analytics/analytics.module";
import { PrivacyModule } from "./privacy/privacy.module";
import { CommunicationModule } from "./communication/communication.module";
import { ReportCardModule } from "./reportcards/reportcard.module";
import { HrModule } from "./hr/hr.module";
import { AdminModule } from "./admin/admin.module";
import { OperatorModule } from "./operator/operator.module";
import { ScholarshipModule } from "./scholarship/scholarship.module";
import { AdmissionsModule } from "./admissions/admissions.module";
import { PublicModule } from "./public/public.module";
import { DirectoryModule } from "./directory/directory.module";
import { AnnouncementsModule } from "./announcements/announcements.module";
import { HostelModule } from "./hostel/hostel.module";
import { TransportModule } from "./transport/transport.module";
import { LibraryModule } from "./library/library.module";
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
    SecurityModule,
    AnalyticsModule,
    PrivacyModule,
    CommunicationModule,
    ReportCardModule,
    HrModule,
    AdminModule,
    OperatorModule,
    ScholarshipModule,
    AdmissionsModule,
    PublicModule,
    DirectoryModule,
    AnnouncementsModule,
    HostelModule,
    TransportModule,
    LibraryModule,
    TaskModule,
    PollModule,
    DiscussionModule,
    DisciplineModule,
    CertificateModule,
    AlumniModule,
    FormModule,
    GameModule,
    GameSocketModule,
  ],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  // Per-request prom-client metrics on EVERY route (records on response finish, so
  // it sees the final status + the matched principal). Request LOGGING is handled
  // automatically by nestjs-pino (ObservabilityModule).
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(MetricsMiddleware).forRoutes("*");
  }
}
