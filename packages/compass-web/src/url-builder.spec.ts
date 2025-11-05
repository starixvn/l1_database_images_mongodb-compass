import { expect } from 'chai';
import {
  getRouteFromWorkspaceTab,
  getWorkspaceTabFromRoute,
} from './url-builder';

describe('url builder helpers', function () {
  describe('getWorkspaceTabFromRoute', function () {
    const specs = [
      ['Welcome', '/', null],
      ['Databases', '/Cluster0', null],
      ['Collections', '/Cluster0/%23db', { namespace: '#db' }],
      ['Collection', '/Cluster0/%23db/coll', { namespace: '#db.coll' }],
      [
        'Collection',
        '/Cluster0/%23db/coll/find',
        { namespace: '#db.coll', initialSubtab: 'Documents' },
      ],
      [
        'Collection',
        '/Cluster0/%23db/coll/aggregation',
        { namespace: '#db.coll', initialSubtab: 'Aggregations' },
      ],
      [
        'Collection',
        '/Cluster0/%23db/coll/schema',
        { namespace: '#db.coll', initialSubtab: 'Schema' },
      ],
      [
        'Collection',
        '/Cluster0/%23db/coll/indexes',
        { namespace: '#db.coll', initialSubtab: 'Indexes' },
      ],
      [
        'Collection',
        '/Cluster0/%23db/coll/validation',
        { namespace: '#db.coll', initialSubtab: 'Validation' },
      ],
      ['Collection', '/Cluster0/%23db/coll/foobar', { namespace: '#db.coll' }],
    ] as const;

    for (const [type, route, extraParams] of specs) {
      it(`should return ${type} workspace when initial route is ${route}`, function () {
        expect(getWorkspaceTabFromRoute(route)).to.deep.eq({
          type,
          ...(type !== 'Welcome' && { connectionId: 'Cluster0' }),
          ...extraParams,
        });
      });
    }
  });

  describe('getRouteFromWorkspaceTab', function () {
    const specs = [
      ['/', { type: 'Welcome' }],
      ['/Cluster0', { type: 'Databases' }],
      ['/Cluster0/db', { type: 'Collections', namespace: 'db' }],
      ['/Cluster0/db/%23coll', { type: 'Collection', namespace: 'db.#coll' }],
      [
        '/Cluster0/db/%23coll/find',
        { type: 'Collection', namespace: 'db.#coll', subTab: 'Documents' },
      ],
      [
        '/Cluster0/db/%23coll/aggregation',
        { type: 'Collection', namespace: 'db.#coll', subTab: 'Aggregations' },
      ],
      [
        '/Cluster0/db/%23coll/schema',
        { type: 'Collection', namespace: 'db.#coll', subTab: 'Schema' },
      ],
      [
        '/Cluster0/db/%23coll/indexes',
        { type: 'Collection', namespace: 'db.#coll', subTab: 'Indexes' },
      ],
      [
        '/Cluster0/db/%23coll/validation',
        { type: 'Collection', namespace: 'db.#coll', subTab: 'Validation' },
      ],
      [
        '/Cluster0/db/%23coll',
        { type: 'Collection', namespace: 'db.#coll', subTab: 'FooBar' },
      ],
    ] as const;

    for (const [route, workspace] of specs) {
      it(`should return ${route} route when workspace is ${workspace.type}`, function () {
        expect(
          getRouteFromWorkspaceTab(
            workspace.type === 'Welcome'
              ? workspace
              : ({ ...workspace, connectionId: 'Cluster0' } as any)
          )
        ).to.eq(route);
      });
    }
  });

  describe('with base path', function () {
    let originalBasePath: string;

    before(function () {
      // Store original value
      originalBasePath = process.env.COMPASS_WEB_BASE_PATH || '';
    });

    after(function () {
      // Restore original value
      if (originalBasePath) {
        process.env.COMPASS_WEB_BASE_PATH = originalBasePath;
      } else {
        delete process.env.COMPASS_WEB_BASE_PATH;
      }
    });

    beforeEach(function () {
      // Set base path for these tests
      process.env.COMPASS_WEB_BASE_PATH = '/compass';
      // Force module to reload with new environment variable
      delete require.cache[require.resolve('./url-builder')];
    });

    afterEach(function () {
      // Clean up for next test
      delete process.env.COMPASS_WEB_BASE_PATH;
      delete require.cache[require.resolve('./url-builder')];
    });

    it('should handle base path in getWorkspaceTabFromRoute', function () {
      const { getWorkspaceTabFromRoute } = require('./url-builder');

      expect(getWorkspaceTabFromRoute('/compass/')).to.deep.eq({
        type: 'Welcome',
      });

      expect(getWorkspaceTabFromRoute('/compass/Cluster0')).to.deep.eq({
        type: 'Databases',
        connectionId: 'Cluster0',
      });
    });

    it('should handle base path in getRouteFromWorkspaceTab', function () {
      const { getRouteFromWorkspaceTab } = require('./url-builder');

      expect(getRouteFromWorkspaceTab({ type: 'Welcome' })).to.eq('/compass/');

      expect(
        getRouteFromWorkspaceTab({
          type: 'Databases',
          connectionId: 'Cluster0',
        })
      ).to.eq('/compass/Cluster0');
    });
  });
});
