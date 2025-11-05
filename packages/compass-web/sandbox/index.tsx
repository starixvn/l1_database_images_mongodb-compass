import { Body, css, openToast, resetGlobalCSS } from '@mongodb-js/compass-components';
import type { AllPreferences } from 'compass-preferences-model';
import React, { useCallback, useRef } from 'react';
import ReactDOM from 'react-dom';
import { SandboxConnectionStorageProvider } from '../src/connection-storage';
import { CompassWeb } from '../src/index';
import {
  SandboxPreferencesUpdateProvider,
  type SandboxPreferencesUpdateTrigger,
} from '../src/preferences';
import { sandboxConnectionStorage } from './sandbox-connection-storage';
import { sandboxLogger } from './sandbox-logger';
import { sandboxTelemetry } from './sandbox-telemetry';
import { useWorkspaceTabRouter } from './sandbox-workspace-tab-router';

const sandboxContainerStyles = css({
  width: '100%',
  height: '100%',
});

resetGlobalCSS();

function getMetaEl(name: string) {
  return (
    document.querySelector(`meta[name="${name}" i]`) ??
    (() => {
      const el = document.createElement('meta');
      el.setAttribute('name', name);
      document.head.prepend(el);
      return el;
    })()
  );
}

const App = () => {
  const [currentTab, updateCurrentTab] = useWorkspaceTabRouter();

  const atlasServiceSandboxBackendVariant = 'web-sandbox-atlas';

  const sandboxPreferencesUpdateTrigger =
    useRef<null | SandboxPreferencesUpdateTrigger>(null);

  const enablePreferencesUpdateTrigger =
    process.env.E2E_TEST_CLOUD_WEB_ENABLE_PREFERENCE_SAVING === 'true';
  if (
    enablePreferencesUpdateTrigger &&
    sandboxPreferencesUpdateTrigger.current === null
  ) {
    sandboxPreferencesUpdateTrigger.current = (
      updatePreference: (preferences: Partial<AllPreferences>) => Promise<void>
    ) => {
      // Useful for e2e test to override preferences.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__compassWebE2ETestSavePreferences = async (
        attributes: Partial<AllPreferences>
      ) => {
        await updatePreference(attributes);
      };

      return () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (globalThis as any).__compassWebE2ETestSavePreferences;
      };
    };
  }

  const onFailToLoadConnections = useCallback((error: Error) => {
    openToast('failed-to-load-connections', {
      title: 'Failed to load connections',
      description: error.message,
      variant: 'warning',
    });
  }, []);

  const isAtlas = false;

  // Parse environment variables for configurable options
  const readOnly = process.env.COMPASS_WEB_READ_ONLY === 'true';
  const enableImportExport = process.env.COMPASS_WEB_ENABLE_IMPORT_EXPORT === 'true';
  const enableShell = process.env.COMPASS_WEB_ENABLE_SHELL === 'true';
  const enableForcedDirectConnection = process.env.COMPASS_WEB_DIRECT_CONNECTION === 'true';

  return (
    <SandboxConnectionStorageProvider
      value={isAtlas ? null : sandboxConnectionStorage}
    >
      <SandboxPreferencesUpdateProvider
        value={sandboxPreferencesUpdateTrigger.current}
      >
        <Body as="div" className={sandboxContainerStyles}>
          <CompassWeb
            orgId={''}
            projectId={''}
            onActiveWorkspaceTabChange={updateCurrentTab}
            initialWorkspace={currentTab ?? undefined}
            initialPreferences={{
              enableExportSchema: true,
              enablePerformanceAdvisorBanner: isAtlas,
              enableAtlasSearchIndexes: true,
              maximumNumberOfActiveConnections: 100,
              atlasServiceBackendPreset: atlasServiceSandboxBackendVariant,
              enableGlobalWrites: false,
              enableRollingIndexes: isAtlas,
              showDisabledConnections: true,
              enableGenAIFeaturesAtlasProject: false,
              enableGenAISampleDocumentPassingOnAtlasProject: false,
              enableGenAIFeaturesAtlasOrg: false,
              optInGenAIFeatures: false,
              enableDataModeling: true,

              readOnly,
              protectConnectionStrings: true,
              protectConnectionStringsForNewConnections: true,
              forceConnectionOptions: [
                ['appName', 'TechiesCompassWeb'],
                ['authSource', 'admin'],
                ...(enableForcedDirectConnection ? [['directConnection', 'true'] as [string, string]] : []),
                ['readConcernLevel', 'local'],
                ['readPreference', 'secondaryPreferred'],
              ],
              enableCreatingNewConnections: true,

              enableShell,
              enableDbAndCollStats: true,

              enableImportExport,
              enableRenameCollectionModal: false,

            }}
            onTrack={sandboxTelemetry.track}
            onDebug={sandboxLogger.debug}
            onLog={sandboxLogger.log}
            onFailToLoadConnections={onFailToLoadConnections}
          ></CompassWeb>
        </Body>
      </SandboxPreferencesUpdateProvider>
    </SandboxConnectionStorageProvider>
  );
};

ReactDOM.render(<App></App>, document.querySelector('#sandbox-app'));
