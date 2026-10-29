import { Component } from '@angular/core';
@Component({
  selector: 'app-users',
  templateUrl: './users.component.html',
})
export class UsersComponent {}

@Component({
  selector: 'app-banner',
  template: `<ds-banner class="wide" tone="info">Heads up</ds-banner>`,
})
export class BannerComponent {}
