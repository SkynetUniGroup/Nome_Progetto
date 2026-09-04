import { Controller, Get, Param, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ReportsService } from './reports.service';
import { ReportsExportService } from './reports-export.service';
import { ListReportsQueryDto } from './dto/list-reports-query.dto';
import { ExportReportQueryDto } from './dto/export-report-query.dto';
import { ReportSummaryDto } from './dto/report-summary.dto';
import { ReportDto } from './dto/report.dto';

// Every route here is personal to the caller — no RolesGuard, just proof of
// identity, same shape as TasksController/RepositoriesController: what a
// caller may see is already settled by which Reports carry their userId,
// not by their role.
@Controller('reports')
@UseGuards(JwtAuthGuard)
export class ReportsController {
  constructor(
    private readonly reportsService: ReportsService,
    private readonly reportsExportService: ReportsExportService,
  ) {}

  @Get()
  findAll(
    @CurrentUser('userId') userId: string,
    @Query() query: ListReportsQueryDto,
  ): Promise<ReportSummaryDto[]> {
    return this.reportsService.findAllForUser(userId, query);
  }

  @Get(':id')
  findOne(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
  ): Promise<ReportDto> {
    return this.reportsService.findOneForUser(userId, id);
  }

  // BE-20: @Res() in raw mode (no {passthrough: true}) — this handler needs
  // to send a binary PDF, an empty 409, or a bespoke error JSON depending on
  // outcome, none of which fits returning a single typed value the way
  // every other route on this controller does. See ReportsExportService for
  // why.
  @Get(':id/export')
  async export(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
    @Query() _query: ExportReportQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    await this.reportsExportService.export(userId, id, res);
  }
}
