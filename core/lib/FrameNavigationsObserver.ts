import { assert, createPromise } from '@ulixee/commons/lib/utils';
import {
  ILoadStatus,
  ILocationTrigger,
  LoadStatus,
  LoadStatusPipeline,
  LocationStatus,
  LocationTrigger,
} from '@ulixee/hero-interfaces/Location';

import { ContentPaint, NavigationReason } from '@ulixee/hero-interfaces/INavigation';
import type ICommandMeta from '@ulixee/hero-interfaces/ICommandMeta';
import type IWaitForOptions from '@ulixee/hero-interfaces/IWaitForOptions';
import type IResolvablePromise from '@ulixee/commons/interfaces/IResolvablePromise';
import { CanceledPromiseError } from '@ulixee/commons/interfaces/IPendingWaitEvent';
import type { IBoundLog } from '@ulixee/commons/interfaces/ILog';
import type FrameNavigations from './FrameNavigations';

export default class FrameNavigationsObserver {
  private readonly navigations: FrameNavigations;

  // this is the default "starting" point for a wait-for location change if a previous command id is not specified
  private defaultWaitForLocationCommandId = 0;

  private waitingForLoadTimeout: NodeJS.Timeout;
  private resourceIdResolvable: IResolvablePromise<number>;
  private statusTriggerResolvable: IResolvablePromise<void>;
  private statusTrigger: LocationStatus;
  private statusTriggerStartCommandId: number;
  private logger: IBoundLog;

  constructor(navigations: FrameNavigations) {
    this.navigations = navigations;
    this.logger = navigations.logger.createChild(module);
    navigations.on('status-change', this.onLoadStatusChange.bind(this));
  }

  // this function will find the "starting command" to look for waitForLocation(change/reload)
  public willRunCommand(newCommand: ICommandMeta, previousCommands: ICommandMeta[]) {
    let last: ICommandMeta;
    for (const command of previousCommands) {
      // if this is a goto, set this to the "waitForLocation(change/reload)" command marker
      if (command.name === 'goto') this.defaultWaitForLocationCommandId = command.id;
      // find the last "waitFor" command that is not followed by another waitFor
      if (last?.name.startsWith('waitFor') && !command.name.startsWith('waitFor')) {
        this.defaultWaitForLocationCommandId = command.id;
      }
      last = command;
    }
    // handle cases like waitForLocation two times in a row
    if (
      newCommand.name === 'waitForLocation' &&
      last &&
      last.name.startsWith('waitFor') &&
      last.name !== 'waitForMillis'
    ) {
      this.defaultWaitForLocationCommandId = newCommand.id;
    }
  }

  public waitForLocation(status: ILocationTrigger, options: IWaitForOptions = {}): Promise<void> {
    assert(LocationTrigger[status], `Invalid location status: ${status}`);

    // determine if this location trigger has already been satisfied
    const sinceCommandId = Number.isInteger(options.sinceCommandId)
      ? options.sinceCommandId
      : this.defaultWaitForLocationCommandId;

    if (this.hasLocationTrigger(status, sinceCommandId)) {
      return Promise.resolve();
    }
    // otherwise set pending
    return this.createStatusTriggeredPromise(status, options.timeoutMs, sinceCommandId);
  }

  public waitForLoad(status: ILoadStatus, options: IWaitForOptions = {}): Promise<void> {
    assert(LoadStatus[status], `Invalid load status: ${status}`);

    if (options.sinceCommandId) {
      throw new Error('Not implemented');
    }

    const top = this.navigations.top;
    if (this.navigations.hasLoadStatus(status)) return;

    const promise = this.createStatusTriggeredPromise(status, options.timeoutMs);

    if (top) this.onLoadStatusChange();
    return promise;
  }

  public waitForReady(): Promise<void> {
    return this.waitForLoad(LoadStatus.DomContentLoaded);
  }

  public async waitForNavigationResourceId(): Promise<number> {
    const top = this.navigations.top;

    this.resourceIdResolvable = top?.resourceId;
    const resourceId = await this.resourceIdResolvable?.promise;
    if (top?.navigationError) {
      throw top.navigationError;
    }
    return resourceId;
  }

  public cancelWaiting(cancelMessage: string): void {
    clearTimeout(this.waitingForLoadTimeout);
    for (const promise of [this.resourceIdResolvable, this.statusTriggerResolvable]) {
      if (!promise || promise.isResolved) continue;

      const canceled = new CanceledPromiseError(cancelMessage);
      canceled.stack += `\n${'------LOCATION'.padEnd(50, '-')}\n${promise.stack}`;
      promise.reject(canceled);
    }
  }

  private onLoadStatusChange(): void {
    if (
      this.statusTrigger === LocationTrigger.change ||
      this.statusTrigger === LocationTrigger.reload
    ) {
      if (this.hasLocationTrigger(this.statusTrigger, this.statusTriggerStartCommandId)) {
        this.resolvePendingStatus(this.statusTrigger);
      }
      return;
    }

    const loadTrigger = LoadStatusPipeline[this.statusTrigger];
    if (!this.statusTriggerResolvable || this.statusTriggerResolvable.isResolved || !loadTrigger)
      return;

    if (this.statusTrigger === LoadStatus.PaintingStable) {
      this.waitForPageLoaded();
      return;
    }

    // otherwise just look for state changes > the trigger
    for (const status of this.navigations.top.statusChanges.keys()) {
      // don't resolve states for redirected
      if (status === LoadStatus.HttpRedirected) continue;
      let pipelineStatus: number = LoadStatusPipeline[status];
      if (status === LoadStatus.AllContentLoaded) {
        pipelineStatus = LoadStatusPipeline.AllContentLoaded;
      }
      if (pipelineStatus >= loadTrigger) {
        this.resolvePendingStatus(status);
        return;
      }
    }
  }

  private waitForPageLoaded(): void {
    clearTimeout(this.waitingForLoadTimeout);

    const { isStable, timeUntilReadyMs } = this.navigations.getPaintStableStatus();

    if (isStable) this.resolvePendingStatus('PaintingStable + Load');

    if (!isStable && timeUntilReadyMs) {
      const loadDate = this.navigations.top.statusChanges.get(LoadStatus.AllContentLoaded);
      const contentPaintDate = this.navigations.top.statusChanges.get(ContentPaint);
      this.waitingForLoadTimeout = setTimeout(
        () =>
          this.resolvePendingStatus(
            `TimeElapsed. Loaded="${loadDate}", ContentPaint="${contentPaintDate}"`,
          ),
        timeUntilReadyMs,
      ).unref();
    }
  }

  private resolvePendingStatus(resolvedWithStatus: LoadStatus | string): void {
    if (this.statusTriggerResolvable && !this.statusTriggerResolvable?.isResolved) {
      this.logger.info(`Resolving pending "${this.statusTrigger}" with trigger`, {
        resolvedWithStatus,
        waitingForStatus: this.statusTrigger,
        url: this.navigations.currentUrl,
      });
      clearTimeout(this.waitingForLoadTimeout);
      this.statusTriggerResolvable.resolve();
      this.statusTriggerResolvable = null;
      this.statusTrigger = null;
      this.statusTriggerStartCommandId = null;
    }
  }

  private hasLocationTrigger(trigger: ILocationTrigger, sinceCommandId: number) {
    let previousLoadedUrl: string;
    for (const history of this.navigations.history) {
      const isMatch = history.startCommandId >= sinceCommandId;
      if (isMatch) {
        let isLocationChange = false;
        if (trigger === LocationTrigger.reload) {
          isLocationChange = FrameNavigationsObserver.isNavigationReload(history.navigationReason);
        }

        // if there was a previously loaded url, use this change
        if (
          trigger === LocationTrigger.change &&
          previousLoadedUrl &&
          previousLoadedUrl !== history.finalUrl
        ) {
          // Don't accept adding a slash as a page change
          const isInPageUrlAdjust =
            history.navigationReason === 'inPage' &&
            history.finalUrl.replace(previousLoadedUrl, '').length <= 1;

          if (!isInPageUrlAdjust) isLocationChange = true;
        }

        if (isLocationChange) {
          this.logger.info(`Resolving waitForLocation(${trigger}) with navigation history`, {
            historyEntry: history,
            status: trigger,
            sinceCommandId,
          });
          return true;
        }
      }

      if (
        (history.statusChanges.has(LoadStatus.HttpResponded) ||
          history.statusChanges.has(LoadStatus.DomContentLoaded)) &&
        !history.statusChanges.has(LoadStatus.HttpRedirected)
      ) {
        previousLoadedUrl = history.finalUrl;
      }
    }
    return false;
  }

  private createStatusTriggeredPromise(
    status: LocationStatus,
    timeoutMs: number,
    sinceCommandId?: number,
  ): Promise<void> {
    if (this.statusTriggerResolvable) this.cancelWaiting('New location trigger created');

    this.statusTrigger = status;
    this.statusTriggerStartCommandId = sinceCommandId;
    this.statusTriggerResolvable = createPromise<void>(timeoutMs ?? 60e3);
    return this.statusTriggerResolvable.promise;
  }

  private static isNavigationReload(reason: NavigationReason): boolean {
    return reason === 'httpHeaderRefresh' || reason === 'metaTagRefresh' || reason === 'reload';
  }
}
