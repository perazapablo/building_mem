import { Pipe, PipeTransform } from '@angular/core';
import { ageDays, formatAbsolute, formatFull, formatRelative } from './date-utils';

@Pipe({ name: 'dateAbs', standalone: true })
export class DateAbsPipe implements PipeTransform {
  transform(v: string | null | undefined): string { return formatAbsolute(v); }
}

@Pipe({ name: 'dateRel', standalone: true })
export class DateRelPipe implements PipeTransform {
  transform(v: string | null | undefined): string { return formatRelative(v); }
}

@Pipe({ name: 'dateFull', standalone: true })
export class DateFullPipe implements PipeTransform {
  transform(v: string | null | undefined): string { return formatFull(v); }
}

@Pipe({ name: 'ageDays', standalone: true })
export class AgeDaysPipe implements PipeTransform {
  transform(v: string | null | undefined): number { return ageDays(v); }
}
