import { CommonModule } from '@angular/common';
import { Component, Input } from '@angular/core';

@Component({
  selector: 'app-section-card',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './section-card.component.html',
  styleUrl: './section-card.component.scss',
})
export class SectionCardComponent {
  @Input() title?: string;
  @Input() badge?: string | number;
  @Input() collapsible = false;
  @Input() collapsed = false;

  toggle() {
    if (this.collapsible) this.collapsed = !this.collapsed;
  }
}
