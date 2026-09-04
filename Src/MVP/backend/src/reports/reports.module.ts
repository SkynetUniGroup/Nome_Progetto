import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Report, ReportSchema } from './schemas/report.schema';
import {
  AnalysisContext,
  AnalysisContextSchema,
} from '../contexts/schemas/analysis-context.schema';
import { Task, TaskSchema } from '../tasks/schemas/task.schema';
import { OperationsModule } from '../operations/operations.module';
import { ReportAssemblyService } from './report-assembly.service';
import { ReportArtifactStorageService } from './report-artifact-storage.service';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { ReportsExportService } from './reports-export.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Report.name, schema: ReportSchema },
      // Both registered directly here rather than importing ContextsModule/
      // TasksModule, same reasoning as TasksModule's own AnalysisContext
      // registration: this module only needs the models — for
      // ReportAssemblyService's denormalization read and BE-19's
      // pendingAction lookup — not those modules' controllers/services.
      // TasksModule already imports *this* module (for
      // ReportAssemblyService); importing TasksModule back would be
      // circular.
      { name: AnalysisContext.name, schema: AnalysisContextSchema },
      { name: Task.name, schema: TaskSchema },
    ]),
    OperationsModule,
  ],
  controllers: [ReportsController],
  providers: [
    ReportAssemblyService,
    ReportsService,
    ReportArtifactStorageService,
    ReportsExportService,
  ],
  exports: [MongooseModule, ReportAssemblyService],
})
export class ReportsModule {}
