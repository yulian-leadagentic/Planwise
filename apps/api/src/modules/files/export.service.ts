import { Injectable } from '@nestjs/common';

@Injectable()
export class ExportService {
  async generateExcel(
    sheetName: string,
    headers: string[],
    rows: any[][],
  ): Promise<Buffer> {
    const ExcelJS = await import('exceljs');
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(sheetName);

    // Add headers
    const headerRow = sheet.addRow(headers);
    headerRow.font = { bold: true };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' },
    };

    // Add data rows
    for (const row of rows) {
      sheet.addRow(row);
    }

    // Auto-fit columns
    sheet.columns.forEach((col) => {
      let maxLength = 10;
      col.eachCell?.({ includeEmpty: false }, (cell) => {
        const len = cell.value ? cell.value.toString().length : 0;
        if (len > maxLength) maxLength = len;
      });
      col.width = Math.min(maxLength + 2, 40);
    });

    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  async generatePdf(
    title: string,
    content: { headers: string[]; rows: string[][] },
  ): Promise<Buffer> {
    const PDFDocument = (await import('pdfkit')).default;

    return new Promise((resolve) => {
      const doc = new PDFDocument({ margin: 50, size: 'A4', layout: 'landscape' });
      const chunks: Buffer[] = [];

      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));

      // Title
      doc.fontSize(16).font('Helvetica-Bold').text(title, { align: 'center' });
      doc.moveDown();

      // Date
      doc
        .fontSize(9)
        .font('Helvetica')
        .text(`Generated: ${new Date().toLocaleDateString()}`, { align: 'right' });
      doc.moveDown();

      // Simple table
      const colWidth = (doc.page.width - 100) / content.headers.length;
      const startX = 50;
      let y = doc.y;

      // Header row
      doc.font('Helvetica-Bold').fontSize(8);
      content.headers.forEach((header, i) => {
        doc.text(header, startX + i * colWidth, y, { width: colWidth, align: 'left' });
      });
      y += 15;
      doc.moveTo(startX, y).lineTo(doc.page.width - 50, y).stroke();
      y += 5;

      // Data rows
      doc.font('Helvetica').fontSize(8);
      for (const row of content.rows) {
        if (y > doc.page.height - 50) {
          doc.addPage();
          y = 50;
        }
        row.forEach((cell, i) => {
          doc.text(cell || '', startX + i * colWidth, y, { width: colWidth, align: 'left' });
        });
        y += 14;
      }

      doc.end();
    });
  }
}
