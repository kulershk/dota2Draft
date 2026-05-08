import type { JobInfo } from '../types.js'
import { CronManager } from '../cron-manager.js'

export const Job = (info: JobInfo): ClassDecorator => {
  return (target: any) => {
    CronManager.loadJob({ info, target })
  }
}
