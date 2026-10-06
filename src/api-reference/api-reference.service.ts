import { Injectable, type Type } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { buildOpenApi, type BuiltReference } from './openapi.js';
import { renderReferencePage } from './reference-page.js';
import { discoverRoutes } from './route-discovery.js';
import { ROUTE_DOCS } from './route-docs.js';

@Injectable()
export class ApiReferenceService {
  private built: BuiltReference | null = null;
  private page: string | null = null;

  constructor(private readonly discovery: DiscoveryService) {}

  reference(): BuiltReference {
    if (!this.built) {
      const controllers = this.discovery
        .getControllers()
        .map((wrapper) => wrapper.metatype)
        .filter((metatype): metatype is Type => typeof metatype === 'function');
      this.built = buildOpenApi(discoverRoutes(controllers), ROUTE_DOCS);
    }
    return this.built;
  }

  html(): string {
    this.page ??= renderReferencePage(this.reference().document);
    return this.page;
  }
}
