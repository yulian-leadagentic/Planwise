/**
 * POST /zones/apply-task-template body, run through a ValidationPipe
 * configured exactly like the global one in `main.ts` (whitelist +
 * forbidNonWhitelisted + implicit conversion).
 */
import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';

import { ApplyTaskTemplateDto } from './apply-task-template.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});
const meta: ArgumentMetadata = { type: 'body', metatype: ApplyTaskTemplateDto };

async function rejection(body: unknown): Promise<BadRequestException> {
  try {
    await pipe.transform(body, meta);
  } catch (err) {
    return err as BadRequestException;
  }
  throw new Error('expected the ValidationPipe to reject the body');
}

describe('ApplyTaskTemplateDto', () => {
  it('accepts a project-root body (zoneId null) with null context fields', async () => {
    const dto: ApplyTaskTemplateDto = await pipe.transform(
      {
        projectId: 59,
        templateId: 41,
        zoneId: null,
        projectDeliverableId: null,
        deliverableTemplateId: null,
        phaseId: null,
        serviceTypeId: null,
      },
      meta,
    );
    expect(dto).toBeInstanceOf(ApplyTaskTemplateDto);
    expect(dto.zoneId).toBeNull();
    expect(dto.projectId).toBe(59);
  });

  it('accepts a zone body with the full group context', async () => {
    const dto: ApplyTaskTemplateDto = await pipe.transform(
      { projectId: 59, templateId: 41, zoneId: 12, projectDeliverableId: 300, deliverableTemplateId: 77, phaseId: 9, serviceTypeId: 5 },
      meta,
    );
    expect(dto).toMatchObject({ zoneId: 12, projectDeliverableId: 300, deliverableTemplateId: 77, phaseId: 9, serviceTypeId: 5 });
  });

  it('requires projectId and templateId', async () => {
    const err = await rejection({ zoneId: 12 });
    expect(err.getStatus()).toBe(400);
    const messages = (err.getResponse() as { message: string[] }).message.join(' ');
    expect(messages).toContain('projectId');
    expect(messages).toContain('templateId');
  });

  it('rejects unknown fields and non-integer ids', async () => {
    expect((await rejection({ projectId: 59, templateId: 41, assignees: [1] })).getStatus()).toBe(400);
    expect((await rejection({ projectId: 59, templateId: 41, zoneId: 'abc' })).getStatus()).toBe(400);
    expect((await rejection({ projectId: 59, templateId: 0 })).getStatus()).toBe(400);
  });
});
