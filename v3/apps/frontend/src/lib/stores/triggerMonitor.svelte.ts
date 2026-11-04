import { requestJson } from '$lib/backend';
import { carmakerStore } from '$lib/stores/carmakerStore.svelte';
import { chatBus } from '$lib/stores/chatBus';
import type { Trigger } from '$lib/types/trigger';

interface TriggerRuntimeStatus {
  monitoringActive: boolean;
  isExecuting: boolean;
}

class TriggerMonitor {
  isMonitoring = $state(false);
  triggers = $state<Trigger[]>([]);
  logMessages = $state<string[]>([]);
  private pollInterval: number | null = null;
  private lastEventId = 0;
  private eventCursorInitialized = false;
  private isPolling = false;

  async loadTriggers(): Promise<void> {
    try {
      this.triggers = await requestJson<Trigger[]>('/api/triggers');
      const runtime = await requestJson<TriggerRuntimeStatus>('/api/triggers/runtime-status');
      this.isMonitoring = runtime.monitoringActive;
      this.logMessages = await requestJson<string[]>('/api/triggers/logs');
      await this.syncEventCursor();
      if (this.isMonitoring || runtime.isExecuting) {
        this.startPolling();
      }
      this.addLog(`✓ Loaded ${this.triggers.length} triggers`);
    } catch (error) {
      this.addLog(`✗ Failed to load triggers: ${String(error)}`);
    }
  }

  async startMonitoring(): Promise<void> {
    if (this.isMonitoring) {
      return;
    }

    await this.loadTriggers();
    try {
      this.isMonitoring = await requestJson<boolean>('/api/triggers/monitoring', {
        method: 'POST',
        body: { active: true },
      });
      this.addLog('✓ Started trigger monitoring');
    } catch (error) {
      this.addLog(`✗ Failed to start trigger monitoring: ${String(error)}`);
    } finally {
      // A failed HTTP response does not prove the backend rejected the start.
      this.startPolling();
    }
  }

  async stopMonitoring(): Promise<void> {
    try {
      this.isMonitoring = await requestJson<boolean>('/api/triggers/monitoring', {
        method: 'POST',
        body: { active: false },
      });
      this.addLog('✓ Stopped trigger monitoring');
      this.startPolling(); // Drain cancellation/error events until the worker has actually exited.
    } catch (error) {
      this.addLog(`✗ Failed to stop trigger monitoring: ${String(error)}`);
    }
  }

  async clearLogs(): Promise<void> {
    try {
      this.logMessages = await requestJson<string[]>('/api/triggers/logs', {
        method: 'DELETE',
      });
    } catch (error) {
      this.addLog(`✗ Failed to clear trigger logs: ${String(error)}`);
    }
  }

  private startPolling(): void {
    if (this.pollInterval !== null) {
      return;
    }

    this.pollInterval = window.setInterval(() => {
      void this.pollRuntimeState();
    }, 500);
  }

  private stopPolling(): void {
    if (this.pollInterval !== null) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  private async pollRuntimeState(): Promise<void> {
    if (this.isPolling) return;
    this.isPolling = true;
    try {
      const [runtime, logs, carmakerMonitoring] = await Promise.all([
        requestJson<TriggerRuntimeStatus>('/api/triggers/runtime-status'),
        requestJson<string[]>('/api/triggers/logs'),
        requestJson<boolean>('/api/carmaker/monitoring'),
      ]);

      this.isMonitoring = runtime.monitoringActive;
      this.logMessages = logs;
      if (carmakerStore.isMonitoring !== carmakerMonitoring) {
        carmakerStore.syncMonitoringStateFromBackend(
          carmakerMonitoring,
          carmakerMonitoring
            ? '→ Monitoring resumed'
            : '→ Monitoring paused (prevent timeout in low-speed mode)',
        );
      }
      await this.pollEvents();

      if (!runtime.monitoringActive && !runtime.isExecuting) {
        this.stopPolling();
      }
    } catch (error) {
      this.addLog(`✗ Failed to poll trigger runtime: ${String(error)}`);
    } finally {
      this.isPolling = false;
    }
  }

  private async pollEvents(): Promise<void> {
    const events = await requestJson<Array<{
      id: number;
      type: string;
      triggerName: string;
      content: string;
    }>>(`/api/triggers/events?since_id=${this.lastEventId}`);

    for (const event of events) {
      this.lastEventId = Math.max(this.lastEventId, event.id);
      chatBus.pushTriggerEvent({
        type: event.type as 'system' | 'llm_response' | 'error',
        triggerName: event.triggerName,
        content: event.content,
      });
    }
  }

  private async syncEventCursor(): Promise<void> {
    // V2 trigger chat events were live-only browser events. On a fresh reload/remount we should
    // not replay previously buffered backend events into the chat widget.
    if (this.eventCursorInitialized) return;
    const events = await requestJson<Array<{ id: number }>>('/api/triggers/events?since_id=0');
    for (const event of events) {
      this.lastEventId = Math.max(this.lastEventId, event.id);
    }
    this.eventCursorInitialized = true;
  }

  addLog(message: string): void {
    const timestamp = new Date().toLocaleTimeString();
    this.logMessages = [...this.logMessages, `[${timestamp}] ${message}`].slice(-100);
  }
}

export const triggerMonitor = new TriggerMonitor();
