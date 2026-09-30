'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  FILTER_FIELDS,
  OPERATORS,
  countRules,
  defaultOperatorForType,
  emptyFilterTree,
  filterTreeToText,
  getField,
  makeGroup,
  makeRule,
  operatorsForType,
  parseFilterText,
} from '@/lib/inventoryFilters'

const EXAMPLE_SCRIPT = `stock_qty != 0
AND supplier = 'Annam Agencies'`

function buildOptionIndex(sources) {
  const index = {}
  for (const [source, rows] of Object.entries(sources || {})) {
    index[source] = {
      byId: new Map((rows || []).map((row) => [String(row.id), row.name])),
      byName: new Map((rows || []).map((row) => [String(row.name || '').trim().toLowerCase(), String(row.id)])),
    }
  }
  return index
}

function RuleRow({ rule, sources, onChange, onRemove, canRemove }) {
  const field = getField(rule.field) || FILTER_FIELDS[0]
  const operator = OPERATORS[rule.op] || OPERATORS.eq
  const options = field.type === 'select' ? sources[field.source] || [] : []

  function changeField(key) {
    const nextField = getField(key)
    onChange({ ...rule, field: key, op: defaultOperatorForType(nextField.type), value: '', value2: '' })
  }

  function valueInput(valueKey) {
    const current = rule[valueKey] ?? ''
    const set = (value) => onChange({ ...rule, [valueKey]: value })

    if (field.type === 'select' && operator.args === 1) {
      return (
        <select
          value={current}
          onChange={(e) => set(e.target.value)}
          className="border rounded-lg px-2 py-1.5 text-sm min-w-40"
        >
          <option value="">Select {field.label}…</option>
          {options.map((option) => (
            <option key={option.id} value={option.id}>{option.name}</option>
          ))}
        </select>
      )
    }
    if (field.type === 'boolean') {
      return (
        <select
          value={String(current || 'true')}
          onChange={(e) => set(e.target.value)}
          className="border rounded-lg px-2 py-1.5 text-sm"
        >
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      )
    }
    if (operator.args === 'list') {
      if (field.type === 'select') {
        const selected = String(current || '').split(',').filter(Boolean)
        return (
          <select
            multiple
            value={selected}
            onChange={(e) => set(Array.from(e.target.selectedOptions).map((option) => option.value).join(','))}
            className="border rounded-lg px-2 py-1.5 text-sm min-w-40 h-20"
          >
            {options.map((option) => (
              <option key={option.id} value={option.id}>{option.name}</option>
            ))}
          </select>
        )
      }
      return (
        <input
          value={current}
          onChange={(e) => set(e.target.value)}
          placeholder="value1, value2"
          className="border rounded-lg px-2 py-1.5 text-sm min-w-40"
        />
      )
    }
    return (
      <input
        type={field.type === 'number' ? 'number' : 'text'}
        value={current}
        onChange={(e) => set(e.target.value)}
        placeholder={field.type === 'number' ? '0' : 'value'}
        className="border rounded-lg px-2 py-1.5 text-sm min-w-32"
      />
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={rule.field}
        onChange={(e) => changeField(e.target.value)}
        className="border rounded-lg px-2 py-1.5 text-sm"
      >
        {FILTER_FIELDS.map((item) => (
          <option key={item.key} value={item.key}>{item.label}</option>
        ))}
      </select>
      <select
        value={rule.op}
        onChange={(e) => onChange({ ...rule, op: e.target.value, value: '', value2: '' })}
        className="border rounded-lg px-2 py-1.5 text-sm"
      >
        {operatorsForType(field.type).map((item) => (
          <option key={item.key} value={item.key}>{item.label}</option>
        ))}
      </select>
      {operator.args !== 0 && valueInput('value')}
      {operator.args === 2 && (
        <>
          <span className="text-xs text-gray-500">and</span>
          {valueInput('value2')}
        </>
      )}
      <button
        type="button"
        onClick={onRemove}
        disabled={!canRemove}
        className="px-2 py-1 text-xs text-gray-400 hover:text-red-600 disabled:opacity-30"
        title="Remove condition"
      >
        ✕
      </button>
    </div>
  )
}

function GroupEditor({ group, sources, depth, onChange, onRemove }) {
  const connector = group.op === 'or' ? 'OR' : 'AND'

  return (
    <div className={`rounded-lg ${depth === 0 ? '' : 'border border-dashed bg-gray-50'} ${depth === 0 ? '' : 'p-2'}`}>
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <div className="inline-flex rounded-lg border overflow-hidden text-xs">
          {['and', 'or'].map((op) => (
            <button
              key={op}
              type="button"
              onClick={() => onChange({ ...group, op })}
              className={`px-2.5 py-1 font-medium ${
                group.op === op ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-100'
              }`}
            >
              {op.toUpperCase()}
            </button>
          ))}
        </div>
        <span className="text-xs text-gray-500">
          match {connector === 'AND' ? 'all' : 'any'} of the conditions below
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => onChange({ ...group, children: [...group.children, makeRule()] })}
            className="px-2 py-1 text-xs rounded-lg bg-blue-50 text-blue-700 hover:bg-blue-100 font-medium"
          >
            + Condition
          </button>
          {depth < 3 && (
            <button
              type="button"
              onClick={() => onChange({
                ...group,
                children: [...group.children, makeGroup(group.op === 'and' ? 'or' : 'and')],
              })}
              className="px-2 py-1 text-xs rounded-lg bg-purple-50 text-purple-700 hover:bg-purple-100 font-medium"
            >
              + Sub-group
            </button>
          )}
          {onRemove && (
            <button
              type="button"
              onClick={onRemove}
              className="px-2 py-1 text-xs text-gray-400 hover:text-red-600"
            >
              Remove group
            </button>
          )}
        </div>
      </div>

      {group.children.length === 0 ? (
        <div className="text-xs text-gray-400 py-2">No conditions yet — add one to start filtering.</div>
      ) : (
        <div className="space-y-2">
          {group.children.map((child, index) => (
            <div key={child.id} className="flex items-start gap-2">
              <span className={`mt-2 w-10 shrink-0 text-[11px] font-semibold ${
                index === 0 ? 'text-transparent' : 'text-gray-400'
              }`}>
                {connector}
              </span>
              <div className="flex-1 min-w-0">
                {child.kind === 'group' ? (
                  <GroupEditor
                    group={child}
                    sources={sources}
                    depth={depth + 1}
                    onChange={(next) => onChange({
                      ...group,
                      children: group.children.map((item) => (item.id === child.id ? next : item)),
                    })}
                    onRemove={() => onChange({
                      ...group,
                      children: group.children.filter((item) => item.id !== child.id),
                    })}
                  />
                ) : (
                  <RuleRow
                    rule={child}
                    sources={sources}
                    canRemove
                    onChange={(next) => onChange({
                      ...group,
                      children: group.children.map((item) => (item.id === child.id ? next : item)),
                    })}
                    onRemove={() => onChange({
                      ...group,
                      children: group.children.filter((item) => item.id !== child.id),
                    })}
                  />
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function InventoryFilterPanel({
  appliedTree,
  onApply,
  onClear,
  sources = {},
  resultCount,
  queryError = '',
}) {
  const [mode, setMode] = useState('builder')
  const [draft, setDraft] = useState(() => appliedTree || emptyFilterTree())
  const [script, setScript] = useState('')
  const [scriptError, setScriptError] = useState('')
  const optionIndex = useMemo(() => buildOptionIndex(sources), [sources])
  const optionLabels = useMemo(
    () => Object.fromEntries(Object.entries(optionIndex).map(([key, value]) => [key, value.byId])),
    [optionIndex],
  )

  useEffect(() => {
    setDraft(appliedTree || emptyFilterTree())
  }, [appliedTree])

  function switchMode(nextMode) {
    if (nextMode === 'text') setScript(filterTreeToText(draft, optionLabels))
    if (nextMode === 'builder') {
      const parsed = parseFilterText(script, optionIndex)
      if (parsed.error) {
        setScriptError(parsed.error)
        return
      }
      setScriptError('')
      setDraft(parsed.tree)
    }
    setMode(nextMode)
  }

  function apply() {
    if (mode === 'text') {
      const parsed = parseFilterText(script, optionIndex)
      if (parsed.error) {
        setScriptError(parsed.error)
        return
      }
      setScriptError('')
      setDraft(parsed.tree)
      onApply(parsed.tree)
      return
    }
    onApply(draft)
  }

  function clearAll() {
    setDraft(emptyFilterTree())
    setScript('')
    setScriptError('')
    onClear()
  }

  const draftRuleCount = countRules(draft)

  return (
    <div className="rounded-xl border bg-white p-3">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="inline-flex rounded-lg border overflow-hidden text-xs">
          <button
            type="button"
            onClick={() => switchMode('builder')}
            className={`px-3 py-1.5 font-medium ${mode === 'builder' ? 'bg-gray-900 text-white' : 'bg-white text-gray-600 hover:bg-gray-100'}`}
          >
            Builder
          </button>
          <button
            type="button"
            onClick={() => switchMode('text')}
            className={`px-3 py-1.5 font-medium ${mode === 'text' ? 'bg-gray-900 text-white' : 'bg-white text-gray-600 hover:bg-gray-100'}`}
          >
            Filter Console
          </button>
        </div>
        <span className="text-xs text-gray-500">
          Stack unlimited conditions and nest AND / OR groups — filters apply on top of each other.
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={clearAll}
            className="px-3 py-1.5 text-xs rounded-lg border text-gray-600 hover:bg-gray-50"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={apply}
            className="px-4 py-1.5 text-xs rounded-lg bg-blue-600 text-white hover:bg-blue-700 font-medium"
          >
            Apply Filters{draftRuleCount ? ` (${draftRuleCount})` : ''}
          </button>
        </div>
      </div>

      {mode === 'builder' ? (
        <GroupEditor
          group={draft}
          sources={sources}
          depth={0}
          onChange={setDraft}
        />
      ) : (
        <div>
          <textarea
            value={script}
            onChange={(e) => { setScript(e.target.value); setScriptError('') }}
            rows={5}
            spellCheck={false}
            placeholder={EXAMPLE_SCRIPT}
            className="w-full border rounded-lg px-3 py-2 text-sm font-mono"
          />
          <div className="mt-1 text-[11px] text-gray-500 leading-relaxed">
            One condition per line (lines are ANDed unless the line starts with <code>OR</code>). Supports
            <code> = != &gt; &gt;= &lt; &lt;= contains, not contains, starts with, ends with, in (…), between x and y, is empty</code>,
            parentheses for nesting, and <code>#</code> comments.
            Fields: {FILTER_FIELDS.map((field) => field.key).join(', ')}.
          </div>
          {scriptError && <div className="mt-2 text-xs text-red-600">{scriptError}</div>}
        </div>
      )}

      {queryError && <div className="mt-2 text-xs text-red-600">Filter error: {queryError}</div>}
      {resultCount != null && (
        <div className="mt-2 text-xs text-gray-500">{resultCount} products match the applied filters.</div>
      )}
    </div>
  )
}
