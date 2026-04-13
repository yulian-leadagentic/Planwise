import { useState } from 'react';
import { Bell, MessageSquare, UserPlus, AlertCircle, Check } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';

interface NotificationRule {
  event: string;
  label: string;
  icon: any;
  color: string;
  inApp: boolean;
  email: boolean;
  external: boolean;
}

const defaultRules: NotificationRule[] = [
  { event: 'mention', label: 'When mentioned in a message', icon: MessageSquare, color: 'text-blue-600 bg-blue-100', inApp: true, email: true, external: true },
  { event: 'reply', label: 'When someone replies to my message', icon: MessageSquare, color: 'text-indigo-600 bg-indigo-100', inApp: true, email: false, external: false },
  { event: 'assignment', label: 'When assigned to a task', icon: UserPlus, color: 'text-green-600 bg-green-100', inApp: true, email: true, external: true },
  { event: 'status_change', label: 'When task or project status changes', icon: AlertCircle, color: 'text-amber-600 bg-amber-100', inApp: true, email: false, external: false },
  { event: 'message', label: 'New message in my projects', icon: MessageSquare, color: 'text-slate-600 bg-slate-100', inApp: true, email: false, external: false },
  { event: 'overdue', label: 'Task overdue reminder', icon: AlertCircle, color: 'text-red-600 bg-red-100', inApp: true, email: true, external: true },
];

export function NotificationSettingsPage() {
  const [rules, setRules] = useState(defaultRules);
  const [generalSettings, setGeneralSettings] = useState({
    enableMessaging: true,
    enableMentions: true,
    enableAttachments: true,
    enableReplies: true,
    enableResolvedState: true,
    deliveryMode: 'instant' as 'instant' | 'digest',
    externalPlatform: 'none' as 'none' | 'teams' | 'slack' | 'both',
    syncMode: 'notifications_only' as 'notifications_only' | 'deep_link' | 'two_way' | 'full_mirror',
    externalSyncAllowed: true,
    externalReplyAllowed: false,
  });

  const toggleRule = (event: string, field: 'inApp' | 'email' | 'external') => {
    setRules((prev) =>
      prev.map((r) => (r.event === event ? { ...r, [field]: !r[field] } : r)),
    );
  };

  const handleSave = () => {
    // TODO: Save to backend when admin settings API is built
    notify.success('Notification settings saved', { code: 'ADMIN-NOTIF-200' });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Notification Settings"
        description="Configure notification rules, delivery channels, and integration settings"
      />

      {/* General Settings */}
      <div className="rounded-[14px] border border-slate-200 bg-white p-6 space-y-4">
        <h3 className="text-[15px] font-bold text-slate-900">General</h3>
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
          {[
            { key: 'enableMessaging', label: 'Enable internal messaging' },
            { key: 'enableMentions', label: 'Enable @mentions' },
            { key: 'enableAttachments', label: 'Enable attachments' },
            { key: 'enableReplies', label: 'Enable threaded replies' },
            { key: 'enableResolvedState', label: 'Enable resolved/unresolved state' },
          ].map(({ key, label }) => (
            <label key={key} className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={(generalSettings as any)[key]}
                onChange={() => setGeneralSettings((s) => ({ ...s, [key]: !(s as any)[key] }))}
                className="h-4 w-4 rounded border-slate-300 text-blue-600"
              />
              <span className="text-sm text-slate-700">{label}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Delivery Settings */}
      <div className="rounded-[14px] border border-slate-200 bg-white p-6 space-y-4">
        <h3 className="text-[15px] font-bold text-slate-900">Delivery</h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Delivery Mode</label>
            <select
              value={generalSettings.deliveryMode}
              onChange={(e) => setGeneralSettings((s) => ({ ...s, deliveryMode: e.target.value as any }))}
              className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm"
            >
              <option value="instant">Instant notifications</option>
              <option value="digest">Daily digest</option>
            </select>
          </div>
          <div>
            <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">External Platform</label>
            <select
              value={generalSettings.externalPlatform}
              onChange={(e) => setGeneralSettings((s) => ({ ...s, externalPlatform: e.target.value as any }))}
              className="w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm"
            >
              <option value="none">In-app only</option>
              <option value="teams">In-app + Microsoft Teams</option>
              <option value="slack">In-app + Slack</option>
              <option value="both">In-app + Teams + Slack</option>
            </select>
          </div>
        </div>
        {generalSettings.externalPlatform !== 'none' && (
          <div>
            <label className="text-[13px] font-semibold text-slate-700 mb-1.5 block">Sync Mode</label>
            <select
              value={generalSettings.syncMode}
              onChange={(e) => setGeneralSettings((s) => ({ ...s, syncMode: e.target.value as any }))}
              className="w-full max-w-md px-3 py-2.5 rounded-lg border border-slate-200 text-sm"
            >
              <option value="notifications_only">Notifications only (one-way)</option>
              <option value="deep_link">Notify + deep link back to system</option>
              <option value="two_way">Two-way sync (replies come back)</option>
              <option value="full_mirror">Full mirroring</option>
            </select>
          </div>
        )}
      </div>

      {/* Per-Event Rules */}
      <div className="rounded-[14px] border border-slate-200 bg-white overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100">
          <h3 className="text-[15px] font-bold text-slate-900">Notification Rules by Event</h3>
          <p className="text-[12px] text-slate-400 mt-0.5">Configure which channels each event type uses</p>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500">
              <th className="px-6 py-2 text-left font-semibold">Event</th>
              <th className="px-4 py-2 text-center font-semibold w-20">In-App</th>
              <th className="px-4 py-2 text-center font-semibold w-20">Email</th>
              <th className="px-4 py-2 text-center font-semibold w-20">External</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((rule) => {
              const Icon = rule.icon;
              return (
                <tr key={rule.event} className="border-t border-slate-100 hover:bg-slate-50/50">
                  <td className="px-6 py-3">
                    <div className="flex items-center gap-3">
                      <div className={cn('flex h-8 w-8 items-center justify-center rounded-lg', rule.color)}>
                        <Icon className="h-4 w-4" />
                      </div>
                      <span className="text-slate-800 font-medium">{rule.label}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <ToggleButton checked={rule.inApp} onChange={() => toggleRule(rule.event, 'inApp')} />
                  </td>
                  <td className="px-4 py-3 text-center">
                    <ToggleButton checked={rule.email} onChange={() => toggleRule(rule.event, 'email')} />
                  </td>
                  <td className="px-4 py-3 text-center">
                    <ToggleButton
                      checked={rule.external}
                      onChange={() => toggleRule(rule.event, 'external')}
                      disabled={generalSettings.externalPlatform === 'none'}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Save */}
      <div className="flex justify-end">
        <button
          onClick={handleSave}
          className="bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-6 py-2.5 rounded-lg"
        >
          Save Settings
        </button>
      </div>
    </div>
  );
}

function ToggleButton({ checked, onChange, disabled }: { checked: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onChange}
      disabled={disabled}
      className={cn(
        'w-7 h-7 rounded-md border-2 flex items-center justify-center transition-all duration-100 mx-auto',
        checked
          ? 'border-green-500 bg-green-50 text-green-600'
          : 'border-slate-200 bg-white text-transparent hover:border-slate-400',
        disabled && 'opacity-30 cursor-not-allowed',
      )}
    >
      {checked && <Check className="w-4 h-4" />}
    </button>
  );
}
