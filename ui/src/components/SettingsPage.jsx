import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { icons } from '@/lib/icons';
import { cn } from '@/lib/utils';

/** Menu order of the settings surface; every entry is a full page of its own. */
export const SETTINGS_MENU = [
  { key: 'model', icon: 'model', labelKey: 'settings.section.model' },
  { key: 'interface', icon: 'palette', labelKey: 'settings.section.interface' },
  { key: 'personalize', icon: 'personalization', labelKey: 'settings.section.personalization' },
  { key: 'cost', icon: 'balance', labelKey: 'settings.section.cost' },
  { key: 'about', icon: 'info', labelKey: 'settings.section.about' },
];

const THEMES = ['system', 'light', 'dark'];
const FETCH_MODES = ['live', 'mock'];
const PRESET_NAMES = ['default', 'professional', 'compact'];

const EMPTY_FORM = {
  model: '',
  effort: 'high',
  language: 'en-US',
  theme: 'system',
  mock: false,
  apiKey: '',
  maxCellsWrite: 5000,
  maxCellsRead: 2000,
  autoApply: false,
};

function Field({ id, label, hint, children }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint ? <p className="text-muted-foreground text-[11px]">{hint}</p> : null}
    </div>
  );
}

function Section({ title, icon, children, className }) {
  const Icon = icons[icon] || icons.info;
  return (
    <section className={cn('flex flex-col gap-2', className)}>
      <h3 className="flex items-center gap-1.5 text-xs font-semibold">
        <Icon className="text-muted-foreground size-3.5" />
        {title}
      </h3>
      {children}
    </section>
  );
}

function formatMoney(value, currency) {
  const amount = Number(value || 0);
  return `${amount.toFixed(amount < 1 ? 4 : 2)} ${currency || 'USD'}`;
}

/**
 * Full-page settings surface: a menu page plus one page per concern
 * (Model, Interface, Personalize, Cost, About). It replaces the chat area instead of
 * floating above it, which keeps the narrow task pane readable.
 */
export default function SettingsPage({
  t,
  state,
  page,
  locales,
  onNavigate,
  onClose,
  onSave,
  onSaveInterface,
  onSavePersonalization,
  onSavePrompt,
  onResetPrompt,
  onRefreshCost,
  onFetchMode,
  onTheme,
  onAddEntry,
  onEditEntry,
  onRemoveEntry,
  onApplyPreset,
  onUpdatePersonalization,
}) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [promptDraft, setPromptDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const update = (patch) => setForm((current) => ({ ...current, ...patch }));

  useEffect(() => {
    const config = state.config || {};
    setForm({
      model: state.model || config.model || '',
      effort: state.effort || config.effort || 'high',
      language: state.locale,
      theme: state.theme || 'system',
      mock: Boolean(state.mock),
      apiKey: '',
      maxCellsWrite: config.maxCellsWrite || 5000,
      maxCellsRead: config.maxCellsRead || 2000,
      autoApply: Boolean(state.autoApply),
    });
    setError(null);
  }, [
    page,
    state.settingsOpen,
    state.model,
    state.effort,
    state.locale,
    state.theme,
    state.mock,
    state.autoApply,
    state.config,
  ]);

  useEffect(() => {
    setPromptDraft(state.prompt.content || '');
  }, [state.prompt.content, page]);

  const run = async (fn) => {
    setSaving(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const BackIcon = icons.chevronLeft;
  const CloseIcon = icons.close;
  const ChevronIcon = icons.chevronRight;
  const RefreshIcon = icons.reload;
  const BalanceIcon = icons.balance;
  const TrashIcon = icons.trash;

  const activeItem = SETTINGS_MENU.find((item) => item.key === page) || null;
  const entries = state.personalization.entries || [];
  const presetEntry = entries.find((entry) => String(entry.id).startsWith('preset:'));
  const activePreset = presetEntry ? String(presetEntry.id).replace('preset:', '') : 'default';
  const cost = state.cost.data;
  const peak = cost ? cost.peak : null;
  const balanceInfos = cost && cost.balance && cost.balance.balance_infos ? cost.balance.balance_infos : null;

  function renderMenu() {
    return (
      <ul className="flex flex-col gap-0.5" data-testid="settings-menu">
        {SETTINGS_MENU.map((item) => {
          const Icon = icons[item.icon] || icons.info;
          return (
            <li key={item.key}>
              <button
                type="button"
                id={`settings-menu-${item.key}`}
                onClick={() => onNavigate(item.key)}
                className="hover:bg-accent/60 flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs"
              >
                <Icon className="text-muted-foreground size-4 shrink-0" />
                <span className="flex-1 truncate">{t(item.labelKey)}</span>
                <ChevronIcon className="text-muted-foreground size-3.5 shrink-0" />
              </button>
            </li>
          );
        })}
      </ul>
    );
  }

  function renderModel() {
    return (
      <div className="flex flex-col gap-4">
        <Section title={t('settings.apiKey')} icon="key">
          <Input
            id="settings-key"
            type="password"
            autoComplete="off"
            placeholder="sk-…"
            value={form.apiKey}
            onChange={(event) => update({ apiKey: event.target.value })}
          />
          <p className="text-muted-foreground text-[11px]">
            {state.hasKey
              ? t('settings.keyCurrent', { masked: (state.config && state.config.keyMasked) || '***' })
              : t('settings.keyMissing')}
          </p>
        </Section>

        <Section title={t('settings.fetchMode')} icon="refresh">
          <Select
            value={form.mock ? 'mock' : 'live'}
            onValueChange={(value) => {
              const mock = value === 'mock';
              update({ mock });
              onFetchMode(mock);
            }}
          >
            <SelectTrigger id="settings-fetch-mode" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FETCH_MODES.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {t(`settings.fetchMode.${mode}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-[11px]">{t('settings.fetchMode.hint')}</p>
        </Section>

        <Section title={t('settings.section.model')} icon="model">
          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="settings-model">{t('settings.model')}</Label>
              <Select value={form.model} onValueChange={(value) => update({ model: value })}>
                <SelectTrigger id="settings-model" className="w-full">
                  <SelectValue placeholder={form.model} />
                </SelectTrigger>
                <SelectContent>
                  {(state.models || []).map((model) => (
                    <SelectItem key={model} value={model}>
                      {model}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="settings-effort">{t('settings.effort')}</Label>
              <Select value={form.effort} onValueChange={(value) => update({ effort: value })}>
                <SelectTrigger id="settings-effort" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(state.efforts || []).map((entry) => (
                    <SelectItem key={entry.id} value={entry.id}>
                      {t(`effort.${entry.id}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className="text-muted-foreground text-[11px]">{t('settings.effortHint')}</p>
        </Section>

        <Section title={t('settings.section.behavior')} icon="table">
          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="settings-max-write">{t('settings.maxWrite')}</Label>
              <Input
                id="settings-max-write"
                type="number"
                min={10}
                max={50000}
                value={form.maxCellsWrite}
                onChange={(event) => update({ maxCellsWrite: event.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="settings-max-read">{t('settings.maxRead')}</Label>
              <Input
                id="settings-max-read"
                type="number"
                min={10}
                max={50000}
                value={form.maxCellsRead}
                onChange={(event) => update({ maxCellsRead: event.target.value })}
              />
            </div>
          </div>
          <div className="flex items-start gap-2">
            <Switch
              id="settings-auto-apply"
              checked={form.autoApply}
              onCheckedChange={(checked) => update({ autoApply: checked })}
            />
            <Label htmlFor="settings-auto-apply" className="leading-snug">
              {t('settings.autoApply')}
            </Label>
          </div>
          <p className="text-muted-foreground text-[11px]">{t('settings.keyNote')}</p>
        </Section>

        {error ? <p className="text-destructive text-[11px]">{error}</p> : null}

        <Button
          id="settings-save"
          size="sm"
          disabled={saving}
          onClick={() =>
            run(() =>
              onSave({
                model: form.model,
                effort: form.effort,
                apiKey: form.apiKey,
                mock: form.mock,
                maxCellsWrite: form.maxCellsWrite,
                maxCellsRead: form.maxCellsRead,
                autoApply: form.autoApply,
              }),
            )
          }
        >
          {t('settings.save')}
        </Button>
      </div>
    );
  }

  function renderInterface() {
    return (
      <div className="flex flex-col gap-4">
        <Field id="settings-language" label={t('settings.language')}>
          <Select value={form.language} onValueChange={(value) => update({ language: value })}>
            <SelectTrigger id="settings-language" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {locales.map((locale) => (
                <SelectItem key={locale} value={locale}>
                  {t(`lang.${locale}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field id="settings-theme" label={t('settings.theme')}>
          <Select
            value={form.theme}
            onValueChange={(value) => {
              update({ theme: value });
              onTheme(value); // previews immediately, saved with the button below
            }}
          >
            <SelectTrigger id="settings-theme" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {THEMES.map((theme) => (
                <SelectItem key={theme} value={theme}>
                  {t(`theme.${theme}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        {error ? <p className="text-destructive text-[11px]">{error}</p> : null}

        <Button
          id="settings-save-interface"
          size="sm"
          disabled={saving}
          onClick={() => run(() => onSaveInterface({ language: form.language, theme: form.theme }))}
        >
          {t('settings.save')}
        </Button>
      </div>
    );
  }

  function renderPersonalize() {
    return (
      <div className="flex flex-col gap-4">
        <Section title={t('settings.personalize.base')} icon="document">
          <Textarea
            id="settings-prompt"
            rows={5}
            className="font-mono text-[11px]"
            value={promptDraft}
            onChange={(event) => setPromptDraft(event.target.value)}
          />
          <p className="text-muted-foreground text-[11px]">{t('settings.personalize.baseHint')}</p>
          <div className="flex gap-1.5">
            <Button
              id="settings-save-prompt"
              variant="outline"
              size="sm"
              disabled={saving}
              onClick={() => run(() => onSavePrompt(promptDraft))}
            >
              {t('settings.save')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={() =>
                run(async () => {
                  await onResetPrompt();
                })
              }
            >
              {t('settings.prompt.reset')}
            </Button>
          </div>
        </Section>

        <Section title={t('settings.presets')} icon="sparkles">
          <div className="flex flex-wrap gap-1.5" data-testid="settings-presets">
            {PRESET_NAMES.map((preset) => (
              <Button
                key={preset}
                type="button"
                id={`settings-preset-${preset}`}
                size="xs"
                variant={activePreset === preset ? 'default' : 'outline'}
                disabled={saving}
                onClick={() => run(() => onApplyPreset(preset))}
              >
                {t(`settings.preset.${preset}`)}
              </Button>
            ))}
          </div>
          <p className="text-muted-foreground text-[11px]">{t('settings.presets.hint')}</p>
        </Section>

        <Section title={t('settings.personalize.entries')} icon="personalization">
          <p className="text-muted-foreground text-[11px]">{t('settings.personalization.globalHint')}</p>
          {entries.length === 0 ? (
            <p className="text-muted-foreground text-[11px]" data-testid="settings-entries-empty">
              {t('settings.personalize.empty')}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {entries.map((entry, index) => (
                <li key={entry.id} className="flex flex-col gap-1.5 rounded-md border p-2">
                  <div className="flex items-center gap-1.5">
                    <Input
                      id={`settings-entry-title-${index}`}
                      value={entry.title}
                      placeholder={t('settings.personalize.titlePlaceholder')}
                      onChange={(event) => onEditEntry(entry.id, { title: event.target.value })}
                    />
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="shrink-0"
                      aria-label={t('settings.personalize.remove')}
                      onClick={() => onRemoveEntry(entry.id)}
                    >
                      {TrashIcon ? <TrashIcon /> : null}
                    </Button>
                  </div>
                  <Textarea
                    id={`settings-entry-text-${index}`}
                    rows={2}
                    value={entry.text}
                    placeholder={t('settings.personalization.placeholder')}
                    onChange={(event) => onEditEntry(entry.id, { text: event.target.value })}
                  />
                </li>
              ))}
            </ul>
          )}
          <Button variant="outline" size="sm" id="settings-add-entry" onClick={() => onAddEntry('global')}>
            {t('settings.personalize.addGlobal')}
          </Button>
          <p className="text-muted-foreground text-[10px]">{t('settings.personalize.entriesHint')}</p>
        </Section>

        <Section title={t('settings.personalization.file')} icon="table">
          <Textarea
            id="settings-personalization-file"
            rows={3}
            value={state.personalization.file || ''}
            placeholder={t('settings.personalization.placeholder')}
            onChange={(event) => onUpdatePersonalization({ file: event.target.value })}
          />
          <p className="text-muted-foreground text-[11px]">{t('settings.personalization.fileHint')}</p>
          {state.personalization.fileId ? (
            <p className="text-muted-foreground text-[10px]">
              {t('settings.personalization.fileId', { id: state.personalization.fileId })}
            </p>
          ) : null}
        </Section>

        {error ? <p className="text-destructive text-[11px]">{error}</p> : null}

        <Button
          id="settings-save-personalization"
          size="sm"
          disabled={saving}
          onClick={() => run(() => onSavePersonalization({}))}
        >
          {t('settings.personalization.save')}
        </Button>
      </div>
    );
  }

  function renderCost() {
    return (
      <div className="flex flex-col gap-4">
        <Section title={t('settings.cost.balance')} icon="balance">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-xs">
              <BalanceIcon className="text-muted-foreground size-3.5" />
              {t('settings.cost.balance')}
            </span>
            <span className="flex items-center gap-1.5">
              {balanceInfos && balanceInfos.length ? (
                <span className="flex flex-col items-end">
                  {balanceInfos.map((info) => (
                    <span key={`${info.currency}`} className="text-xs font-medium">
                      {info.total_balance} {info.currency}
                    </span>
                  ))}
                </span>
              ) : (
                <span className="text-muted-foreground text-xs">{t('settings.cost.unavailable')}</span>
              )}
              <Button variant="ghost" size="icon-xs" aria-label={t('settings.cost.refresh')} onClick={onRefreshCost}>
                <RefreshIcon className={state.cost.loading ? 'animate-spin' : undefined} />
              </Button>
            </span>
          </div>

          {peak ? (
            <div className="flex items-center gap-1.5">
              <Badge variant={peak.isPeak ? 'destructive' : 'secondary'}>
                {peak.isPeak ? t('settings.cost.peak') : t('settings.cost.offPeak')}
              </Badge>
              {peak.nextChangeInMinutes !== null ? (
                <span className="text-muted-foreground text-[11px]">
                  {t('settings.cost.nextChange', { minutes: peak.nextChangeInMinutes })}
                </span>
              ) : null}
            </div>
          ) : null}
        </Section>

        {cost && cost.prices ? (
          <Section title={t('settings.section.model')} icon="model">
            <ul className="flex flex-col gap-0.5">
              {cost.prices.map((price) => (
                <li key={price.model} className="flex items-center justify-between text-[11px]">
                  <span className="text-muted-foreground">{price.label}</span>
                  <span className="font-mono">
                    in {price.inputCacheMiss} / out {price.output} {price.currency}
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        <Section title={t('settings.cost.session')} icon="clock">
          {state.totals && state.totals.requests ? (
            <p className="text-muted-foreground text-[11px]">
              {formatMoney(state.totals.totalCost, state.totals.currency)} ·{' '}
              {t('settings.cost.requests', { count: state.totals.requests })} ·{' '}
              {t('settings.cost.tokens', {
                input: state.totals.promptTokens,
                output: state.totals.completionTokens,
              })}
            </p>
          ) : (
            <p className="text-muted-foreground text-[11px]">{t('settings.cost.noUsage')}</p>
          )}
          {cost ? (
            <p className="text-muted-foreground text-[10px]">
              {t('settings.cost.pricingNote', {
                source: 'api-docs.deepseek.com',
                version: cost.pricing.version,
                multiplier: cost.pricing.offPeakMultiplier,
              })}
            </p>
          ) : null}
          {state.cost.error ? <p className="text-destructive text-[11px]">{state.cost.error}</p> : null}
          {cost && cost.balanceError ? <p className="text-muted-foreground text-[11px]">{cost.balanceError}</p> : null}
        </Section>
      </div>
    );
  }

  function renderAbout() {
    const config = state.config || {};
    return (
      <div className="flex flex-col gap-3 text-[11px]">
        <p className="text-xs font-semibold">{t('app.project')}</p>
        <p className="text-muted-foreground">{t('settings.keyNote')}</p>
        <dl className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">{t('about.host')}</dt>
            <dd className="font-mono">{config.host || 'excel'}</dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">{t('about.endpoint')}</dt>
            <dd className="truncate font-mono">{config.baseUrl || 'https://api.deepseek.com'}</dd>
          </div>
        </dl>
        <a
          className="underline underline-offset-2"
          href="https://github.com/dezuhan"
          target="_blank"
          rel="noreferrer"
        >
          {t('about.github')}
        </a>
      </div>
    );
  }

  const body =
    page === 'model'
      ? renderModel()
      : page === 'interface'
        ? renderInterface()
        : page === 'personalize'
          ? renderPersonalize()
          : page === 'cost'
            ? renderCost()
            : page === 'about'
              ? renderAbout()
              : renderMenu();

  return (
    <div className="bg-background text-foreground flex h-full min-h-0 flex-col" data-testid="settings-page">
      <header className="flex items-center gap-1 border-b px-1.5 py-1.5">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t('settings.back')}
          data-testid="settings-back"
          onClick={() => (activeItem ? onNavigate(null) : onClose())}
        >
          <BackIcon />
        </Button>
        <h2 className="flex-1 truncate text-xs font-semibold" data-testid="settings-heading">
          {activeItem ? t(activeItem.labelKey) : t('settings.title')}
        </h2>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t('settings.close')}
          data-testid="settings-close"
          onClick={onClose}
        >
          <CloseIcon />
        </Button>
      </header>

      {state.notice ? (
        <p className="border-b bg-emerald-500/10 px-3 py-1 text-[11px] text-emerald-700 dark:text-emerald-400">
          {t(state.notice.key, state.notice.params)}
        </p>
      ) : null}

      <ScrollArea className="pane-scroll min-h-0 flex-1">
        <div className="p-3">{body}</div>
      </ScrollArea>
    </div>
  );
}
