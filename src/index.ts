import debug from 'debug';
import { EventEmitter } from 'events';
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';

import { SupabaseClient } from '@supabase/supabase-js';
import { RealtimeChannel } from '@supabase/realtime-js';
import { REALTIME_LISTEN_TYPES } from '@supabase/realtime-js/src/RealtimeChannel';

export interface SupabaseProviderConfig {
  channel: string;
  tableName: string;
  columnName: string;
  aggregationViewName: string;
  aggregationColumnName: string;
  aggregationIdName?: string;
  idName?: string;
  id: string | number | BigInt;
  awareness?: awarenessProtocol.Awareness;
  resyncInterval?: number | false;
  saveInterval?: number;
}

export default class SupabaseProvider extends EventEmitter {
  public awareness: awarenessProtocol.Awareness;
  public connected = false;
  private channel: RealtimeChannel | null = null;

  private previousSnapshot: Uint8Array | null = null;

  private _synced: boolean = false;
  private resyncInterval: NodeJS.Timer | undefined;
  private debounceUpdate: () => void;
  protected logger: debug.Debugger;
  public readonly id: number;

  public version: number = 0;

  isOnline(online?: boolean): boolean {
    if (!online && online !== false) return this.connected;
    this.connected = online;
    return this.connected;
  }

  onDocumentUpdate(update: Uint8Array, origin: any) {
    if (origin !== this) {
      this.logger('document updated locally, broadcasting update to peers', this.isOnline());
      this.emit('message', update);
      this.debounceUpdate();
    }
  }

  onAwarenessUpdate({ added, updated, removed }: any, origin: any) {
    const changedClients = added.concat(updated).concat(removed);
    const awarenessUpdate = awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients);
    this.emit('awareness', awarenessUpdate);
  }

  removeSelfFromAwarenessOnUnload() {
    if (this.doc != null) {
      awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'window unload');
    }
  }

  async save() {
    const currentSnapshot = Y.encodeStateAsUpdateV2(this.doc);
    this.logger('saving: previousSnapshot', this.previousSnapshot);
    this.logger('saving: currentSnapshot', currentSnapshot);

    let diff;
    if (this.previousSnapshot == null) {
      diff = Y.encodeStateAsUpdateV2(this.doc);
    } else {
      diff = Y.diffUpdateV2(currentSnapshot, this.previousSnapshot);
    }

    this.logger('saving: diff', diff);
    const content = Array.from(diff);

    if (JSON.stringify([0, 0]) === JSON.stringify(content)) {
      return;
    }
    const upsertRecord = {
      [this.config.idName || 'id']: this.config.id.toString(),
      [this.config.columnName]: content,
    } as any;
    this.logger('saving: upsertRecord', upsertRecord);
    const { error } = await this.supabase.from(this.config.tableName).insert(upsertRecord);
    // .eq(this.config.idName || 'id', this.config.id);
    // .eq(this.config.idName || 'id', this.config.id);

    if (error) {
      throw error;
    }

    this.updatePreviousSnapshot();
    this.emit('save', this.version);
  }

  private async onConnect() {
    this.logger('connected');

    this.logger('loading: starting');
    const { data, error, status } = await this.supabase
      .from(this.config.aggregationViewName)
      .select<string, { [key: string]: number[][] }>(`${this.config.aggregationColumnName}`)
      .eq(this.config.aggregationIdName || 'id', this.config.id)
      .maybeSingle();

    this.logger('retrieved data from supabase', status);

    this.logger('loading: data', data);
    if (data && data[this.config.aggregationColumnName]) {
      this.logger('applying update to yjs');
      const diffs = data[this.config.aggregationColumnName];
      this.logger('loading: diffs', diffs);

      if (diffs.length > 0) {
        try {
          this.logger('applying update inner to yjs');
          // this.applyUpdate(Uint8Array.from(diff));
          Y.applyUpdateV2(this.doc, Y.mergeUpdatesV2(diffs.map((diff) => Uint8Array.from(diff))));
          this.updatePreviousSnapshot();
        } catch (error) {
          this.logger('applying resulted in error', error);
        }

        this.version++;
      }
      // this.applyUpdate(Uint8Array.from(data[this.config.columnName]));
    }

    this.logger('setting connected flag to true');
    this.isOnline(true);

    this.emit('status', [{ status: 'connected' }]);

    if (this.awareness.getLocalState() !== null) {
      const awarenessUpdate = awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]);
      this.emit('awareness', awarenessUpdate);
    }
  }

  private applyUpdate(update: Uint8Array, origin?: any) {
    this.version++;
    Y.applyUpdate(this.doc, update, origin);
  }

  private updatePreviousSnapshot() {
    this.previousSnapshot = Y.encodeStateVector(this.doc);
  }

  private disconnect() {
    if (this.channel) {
      this.supabase.removeChannel(this.channel);
      this.channel = null;
    }
  }

  private connect() {
    this.channel = this.supabase.channel(this.config.channel);
    if (this.channel) {
      this.channel
        .on(REALTIME_LISTEN_TYPES.BROADCAST, { event: 'message' }, ({ payload }) => {
          this.onMessage(Uint8Array.from(payload), this);
        })
        .on(REALTIME_LISTEN_TYPES.BROADCAST, { event: 'awareness' }, ({ payload }) => {
          this.onAwareness(Uint8Array.from(payload));
        })
        .subscribe((status, err) => {
          if (status === 'SUBSCRIBED') {
            this.emit('connect', this);
          }

          if (status === 'CHANNEL_ERROR') {
            this.logger('CHANNEL_ERROR', err);
            this.emit('error', this);
          }

          if (status === 'TIMED_OUT') {
            this.emit('disconnect', this);
          }

          if (status === 'CLOSED') {
            this.emit('disconnect', this);
          }
        });
    }
  }

  private debounce<T extends (...args: any[]) => any>(func: T, wait: number) {
    let timeout: ReturnType<typeof setTimeout> | null;
    return (...args: Parameters<T>): Promise<ReturnType<T>> => {
      const later = () => {
        timeout = null;
        return func(...args);
      };
      clearTimeout(timeout!);
      timeout = setTimeout(later, wait);
      return new Promise((resolve) => {
        if (!timeout) {
          resolve(func(...args));
        }
      });
    };
  }
  constructor(private doc: Y.Doc, private supabase: SupabaseClient, private config: SupabaseProviderConfig) {
    super();
    this.awareness = this.config.awareness || new awarenessProtocol.Awareness(doc);

    this.config = config || {};
    this.id = doc.clientID;

    this.supabase = supabase;
    this.on('connect', this.onConnect);
    this.on('disconnect', this.onDisconnect);

    this.logger = debug('y-' + doc.clientID);
    // turn on debug logging to the console
    this.logger.enabled = true;

    this.logger('constructor initializing');
    this.logger('connecting to Supabase Realtime', doc.guid);

    this.debounceUpdate = this.debounce(() => {
      this.logger('saving document');
      this.save();
    }, this.config.saveInterval || 5000);

    if (this.config.resyncInterval || typeof this.config.resyncInterval === 'undefined') {
      if (this.config.resyncInterval && this.config.resyncInterval < 3000) {
        throw new Error('resync interval of less than 3 seconds');
      }
      this.logger(`setting resync interval to every ${(this.config.resyncInterval || 5000) / 1000} seconds`);
      this.resyncInterval = setInterval(() => {
        this.logger('resyncing (resync interval elapsed)');
        this.emit('message', Y.encodeStateAsUpdate(this.doc));
        if (this.channel)
          this.channel.send({
            type: 'broadcast',
            event: 'message',
            payload: Array.from(Y.encodeStateAsUpdate(this.doc)),
          });
      }, this.config.resyncInterval || 5000);
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', this.removeSelfFromAwarenessOnUnload);
    } else if (typeof process !== 'undefined') {
      process.on('exit', () => this.removeSelfFromAwarenessOnUnload);
    }
    this.on('awareness', (update) => {
      if (this.channel)
        this.channel.send({
          type: 'broadcast',
          event: 'awareness',
          payload: Array.from(update),
        });
    });
    this.on('message', (update) => {
      console.log('Got update');
      Y.logUpdate(update);

      if (this.channel)
        this.channel.send({
          type: 'broadcast',
          event: 'message',
          payload: Array.from(update),
        });
    });

    this.connect();
    this.doc.on('update', this.onDocumentUpdate.bind(this));
    this.awareness.on('update', this.onAwarenessUpdate.bind(this));
  }

  get synced() {
    return this._synced;
  }

  set synced(state) {
    if (this._synced !== state) {
      this.logger('setting sync state to ' + state);
      this._synced = state;
      this.emit('synced', [state]);
      this.emit('sync', [state]);
    }
  }

  public onConnecting() {
    if (!this.isOnline()) {
      this.logger('connecting');
      this.emit('status', [{ status: 'connecting' }]);
    }
  }

  public onDisconnect() {
    this.logger('disconnected');

    this.synced = false;
    this.isOnline(false);
    this.logger('set connected flag to false');
    if (this.isOnline()) {
      this.emit('status', [{ status: 'disconnected' }]);
    }

    // update awareness (keep all users except local)
    // FIXME? compare to broadcast channel behavior
    const states = Array.from(this.awareness.getStates().keys()).filter((client) => client !== this.doc.clientID);
    awarenessProtocol.removeAwarenessStates(this.awareness, states, this);
  }

  public onMessage(message: Uint8Array, origin: any) {
    if (!this.isOnline()) return;
    try {
      this.applyUpdate(message, this);
    } catch (err) {
      this.logger(err);
    }
  }

  public onAwareness(message: Uint8Array) {
    awarenessProtocol.applyAwarenessUpdate(this.awareness, message, this);
  }

  public onAuth(message: Uint8Array) {
    this.logger(`received ${message.byteLength} bytes from peer: ${message}`);

    if (!message) {
      this.logger(`Permission denied to channel`);
    }
    this.logger('processed message (type = MessageAuth)');
  }

  public destroy() {
    this.logger('destroying');

    if (this.resyncInterval) {
      clearInterval(this.resyncInterval);
    }

    if (typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', this.removeSelfFromAwarenessOnUnload);
    } else if (typeof process !== 'undefined') {
      process.off('exit', () => this.removeSelfFromAwarenessOnUnload);
    }

    this.awareness.off('update', this.onAwarenessUpdate);
    this.doc.off('update', this.onDocumentUpdate);

    if (this.channel) this.disconnect();
  }
}
