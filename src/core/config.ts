import * as vscode from 'vscode';

import type { ExtensionConfig } from './types';

export const COPILOT_FILE_LOGGING_SETTING = 'github.copilot.chat.agentDebugLog.fileLogging.enabled';

export function isCopilotFileLoggingEnabled(): boolean {
  return vscode.workspace.getConfiguration().get<boolean>(COPILOT_FILE_LOGGING_SETTING, false);
}

export function readConfig(): ExtensionConfig {
  const config = vscode.workspace.getConfiguration('copilotUsage');

  return {
    dataPath: config.get('dataPath', ''),
    maxFileSizeMb: 200,
    maxScanDepth: 12,
  };
}
