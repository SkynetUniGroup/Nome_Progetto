import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Report, ReportDocument } from './schemas/report.schema';
import { Task, TaskDocument } from '../tasks/schemas/task.schema';
import { ListReportsQueryDto } from './dto/list-reports-query.dto';
import { ReportSummaryDto, toReportSummaryDto } from './dto/report-summary.dto';
import { ReportDto, toReportDto } from './dto/report.dto';

@Injectable()
export class ReportsService {
  constructor(
    @InjectModel(Report.name)
    private readonly reportModel: Model<ReportDocument>,
    @InjectModel(Task.name) private readonly taskModel: Model<TaskDocument>,
  ) {}

  // Scoped to the caller and run against the (userId, generatedAt) index
  // report.schema.ts already declares — userId is always the leading,
  // always-present filter; operation/from/to narrow it further.
  async findAllForUser(
    userId: string,
    query: ListReportsQueryDto,
  ): Promise<ReportSummaryDto[]> {
    const filter: Record<string, unknown> = { userId };
    if (query.operation) {
      filter.operation = query.operation;
    }
    if (query.from || query.to) {
      filter.generatedAt = {
        ...(query.from ? { $gte: new Date(query.from) } : {}),
        ...(query.to ? { $lte: new Date(query.to) } : {}),
      };
    }

    const reports = await this.reportModel
      .find(filter)
      .sort({ generatedAt: -1 });
    return reports.map(toReportSummaryDto);
  }

  async findOneForUser(userId: string, id: string): Promise<ReportDto> {
    // Scoped by (id, userId) together in one query, not id alone followed
    // by a separate ownership check — a mismatch has to look identical to
    // "doesn't exist" (404, never 403), so there's no point ever loading a
    // Report this caller isn't allowed to see in the first place.
    const report = await this.reportModel.findOne({ _id: id, userId });
    if (!report) {
      throw new NotFoundException(`Report ${id} not found`);
    }

    // Nothing in this codebase deletes a Task, so a null here would be a
    // data-integrity problem, not a normal 404 — pendingAction just
    // degrades to null rather than failing the whole request over it.
    const task = await this.taskModel.findById(report.taskId);
    const pendingAction = task?.pendingInput ?? null;

    return toReportDto(report, pendingAction);
  }
}
