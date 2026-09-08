import { useId, type ReactNode } from 'react'
import { Close as X } from '@carbon/icons-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useT } from '../lib/i18n'

export function InspectionField({
  label,
  value,
  onChange,
  required,
  multiline,
  disabled,
  placeholder,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  required?: boolean
  multiline?: boolean
  disabled?: boolean
  placeholder?: string
}) {
  const id = useId()
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {label}
        {required ? ' *' : ''}
      </Label>
      {multiline ? (
        <Textarea
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          required={required}
          rows={3}
          maxLength={8000}
          placeholder={placeholder}
        />
      ) : (
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          required={required}
          maxLength={500}
          placeholder={placeholder}
        />
      )}
    </div>
  )
}
export function InspectionSelect({
  label,
  value,
  onChange,
  options,
  disabled,
  empty,
  required,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
  disabled?: boolean
  empty?: string
  required?: boolean
}) {
  const id = useId()
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {label}
        {required ? ' *' : ''}
      </Label>
      <Select
        value={value || '__none__'}
        onValueChange={(v) => onChange(v === '__none__' ? '' : v)}
        disabled={disabled}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {empty && <SelectItem value="__none__">{empty}</SelectItem>}
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
export function InspectionHeading({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const t = useT()
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line px-4 py-3">
      <h2 className="font-sans text-xl font-medium">{children}</h2>
      <Button variant="ghost" size="iconSm" onClick={onClose} aria-label={t('c.close')}>
        <X size={16} />
      </Button>
    </div>
  )
}
