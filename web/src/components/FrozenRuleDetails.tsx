import { useState } from 'react'
import { Close } from '@carbon/icons-react'
import { useLang } from '../lib/i18n'
import type { DetectionEvent } from '../lib/types'
import { confidenceText } from '../lib/monitoring'
import { Modal } from './ui'
import { Button } from './ui/button'

export function FrozenRuleDetails({
  trigger,
  onClose,
}: {
  trigger: NonNullable<DetectionEvent['trigger']>
  onClose: () => void
}) {
  const zh = useLang((s) => s.lang) === 'zh',
    [advanced, setAdvanced] = useState(false),
    c = trigger.configSnapshot
  const schedule = c.schedule as {
    days?: number[]
    start?: string
    end?: string
  } | null
  const days = zh
    ? ['日', '一', '二', '三', '四', '五', '六']
    : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const fields: [string, string][] = [
    [zh ? '名称' : 'Name', String(c.name ?? trigger.ruleId)],
    [zh ? '规则版本' : 'Revision', trigger.revision?.toString() ?? (zh ? '未记录' : 'Not recorded')],
    [
      zh ? '类型' : 'Type',
      trigger.ruleType === 'vision'
        ? zh
          ? '视觉监测'
          : 'Visual monitoring'
        : zh
          ? '指标阈值'
          : 'Metric threshold',
    ],
    [zh ? '触发条件' : 'Trigger condition', trigger.condition],
    ...(trigger.ruleType === 'vision'
      ? ([
          [
            zh ? '置信度下限' : 'Minimum confidence',
            confidenceText(typeof c.confidence === 'number' ? c.confidence : null, zh),
          ],
          [zh ? '持续时间' : 'Duration', typeof c.durationS === 'number' ? `${c.durationS} s` : '—'],
          [
            zh ? '监测时段（UTC）' : 'Schedule (UTC)',
            schedule
              ? `${(schedule.days ?? []).map((d) => days[d]).join(', ')} · ${schedule.start}–${schedule.end}`
              : zh
                ? '持续监测'
                : 'Continuous',
          ],
        ] as [string, string][])
      : []),
  ]
  const geometry = (value: unknown) =>
    Array.isArray(value)
      ? value
          .map((point, index) => `${index + 1}: ${Array.isArray(point) ? point.join(', ') : '—'}`)
          .join(' · ')
      : '—'
  return (
    <Modal wide title={zh ? '触发规则版本' : 'Trigger rule version'} onClose={onClose}>
      <div className="space-y-4 p-4">
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-lg font-medium">{zh ? '触发时的规则配置' : 'Configuration at trigger time'}</h3>
          <Button variant="ghost" size="icon" aria-label={zh ? '关闭' : 'Close'} onClick={onClose}>
            <Close size={16} />
          </Button>
        </div>
        <p className="text-sm text-ink-2">
          {zh
            ? '这是事件保存的冻结版本，后续编辑或删除规则不会改变它。'
            : 'This version was frozen with the event. Later edits or deletion do not change it.'}
        </p>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          {fields.map(([name, value]) => (
            <div key={name}>
              <dt className="text-ink-3">{name}</dt>
              <dd className="break-words">{value}</dd>
            </div>
          ))}
        </dl>
        <Button
          variant="outline"
          aria-expanded={advanced}
          aria-controls="frozen-rule-advanced"
          onClick={() => setAdvanced(!advanced)}
        >
          {zh ? '几何与来源标识' : 'Geometry & source identifiers'}
        </Button>
        {advanced && (
          <dl id="frozen-rule-advanced" className="space-y-3 rounded-md border border-line p-3 text-sm">
            {(['region', 'line'] as const)
              .filter((key) => Array.isArray(c[key]))
              .map((key) => (
                <div key={key}>
                  <dt className="text-ink-3">
                    {key === 'region'
                      ? zh
                        ? '区域顶点（归一化坐标）'
                        : 'Region vertices (normalized coordinates)'
                      : zh
                        ? '线段端点（归一化坐标）'
                        : 'Line endpoints (normalized coordinates)'}
                  </dt>
                  <dd className="mono break-words text-xs">{geometry(c[key])}</dd>
                </div>
              ))}
            {[
              ['Rule', trigger.ruleId],
              ['Adapter', trigger.adapterId],
              ['Source', trigger.sourceId],
              ['Robot', c.robotId],
              ['Metric', c.metric],
              ['Observation', trigger.resultId ?? trigger.observationId],
            ]
              .filter(([, value]) => !!value)
              .map(([name, value]) => (
                <div key={String(name)}>
                  <dt className="text-ink-3">
                    {zh
                      ? (
                          {
                            Rule: '规则',
                            Adapter: 'Adapter',
                            Source: '视频源',
                            Robot: '机器人',
                            Metric: '指标',
                            Observation: '观测',
                          } as Record<string, string>
                        )[String(name)]
                      : String(name)}
                  </dt>
                  <dd className="mono break-all text-xs">{String(value)}</dd>
                </div>
              ))}
          </dl>
        )}
      </div>
    </Modal>
  )
}
