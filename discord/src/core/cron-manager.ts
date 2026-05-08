import type { Client } from 'discord.js'
import { CronJob } from 'cron'
import { Logger } from '../services/logger.js'
import type { LoadedJob, ManagedJob } from './types.js'
import { loadEntities } from './loader.js'

export class CronManager {
  static readonly jobStore = new Map<string, ManagedJob>()
  private static _client: Client | null = null

  static async load(): Promise<void> {
    await loadEntities('jobs')
  }

  static loadJob<T>(job: LoadedJob<T>): void {
    const name = job.target.name
    if (this.jobStore.has(name)) {
      Logger.warn(`Job '${name}' already loaded`)
      return
    }
    if (job.info.enabled === false) return
    if (!this._client) {
      throw new Error('CronManager: client must be set before loading jobs')
    }
    this.jobStore.set(name, {
      info: job.info,
      instance: new (job.target as any)(this._client),
    })
    Logger.info(`Loaded '${name}' job`)
  }

  static start(client: Client): void {
    this._client = client
    for (const [name, job] of this.jobStore) {
      new CronJob(
        job.info.cronTime,
        () => {
          Promise.resolve(job.instance.execute()).catch((e) =>
            Logger.error(`Job '${name}' failed`, e),
          )
        },
        null,
        true,
      )
    }
    Logger.info(`Cron started (${this.jobStore.size} job${this.jobStore.size === 1 ? '' : 's'})`)
  }

  static setClient(client: Client): void {
    this._client = client
  }
}
