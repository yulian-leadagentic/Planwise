import { forwardRef, useId } from 'react';
import type {
  InputHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
  SelectHTMLAttributes,
} from 'react';
import { cn } from '@/lib/utils';

/**
 * Shared form Field wrapper (People UX M5 · E-06 / E-13 / P-30 / P-31 / P-32).
 *
 * Wires up the three a11y primitives every editable field in Planwise
 * needs, so callers stop hand-rolling them (and forgetting one):
 *   • `<label htmlFor>` linked to the control's `id` (auto-generated when
 *     the caller doesn't pass one via useId());
 *   • `*` required marker with `aria-hidden` decorative + `aria-required`
 *     on the control;
 *   • inline error / helper text with `aria-describedby` on the control,
 *     and `aria-invalid` toggled from the presence of `error`.
 *
 * Designed to be dropped in place of the current inline
 *   <label>…</label> + <input …/> + {error && <p>…</p>}
 * pattern without changing the surrounding layout: the wrapper renders a
 * plain <div class="…"> and the caller passes container spacing.
 *
 * Two shapes:
 *   1. `<Field label="…" error="…" required>` + a child render callback
 *      (renderProp `children`) receiving {id, describedBy, ariaInvalid}
 *      for custom controls (selects, comboboxes, our shared multi-select).
 *   2. `<TextField label="…" name="…"/>` — thin convenience that renders
 *      an <input> for the very common text/email/password case.
 */

interface FieldRenderProps {
  /** id to place on the control — matches the label's htmlFor. */
  id: string;
  /** aria-describedby value: helper + error ids joined, or undefined. */
  describedBy: string | undefined;
  /** true when `error` is set — set on the control's aria-invalid. */
  ariaInvalid: boolean;
  /** true when the field is required — set on the control's aria-required. */
  ariaRequired: boolean;
}

export interface FieldProps {
  /** Visible label text (or an already-formatted node). */
  label: ReactNode;
  /** Optional id for the control (else a stable useId one is generated). */
  htmlFor?: string;
  /** When true, renders a red `*` and wires aria-required on the control. */
  required?: boolean;
  /** Inline red validation text under the control. */
  error?: string | null;
  /** Muted helper text under the control (below any error). */
  hint?: ReactNode;
  /**
   * When true, hint is styled amber (advisory / warning) rather than
   * slate. Used for the D1 domain warning on the Employees tab.
   */
  hintTone?: 'muted' | 'warning';
  /** Optional class on the outer wrapper (usually spacing). */
  className?: string;
  /** Optional class on the <label>. */
  labelClassName?: string;
  /** Optional right-of-label content (e.g. a "Manage rate" link). */
  labelSuffix?: ReactNode;
  /** Renders the actual control. */
  children: (props: FieldRenderProps) => ReactNode;
}

export function Field({
  label,
  htmlFor,
  required = false,
  error,
  hint,
  hintTone = 'muted',
  className,
  labelClassName,
  labelSuffix,
  children,
}: FieldProps) {
  const generatedId = useId();
  const id = htmlFor ?? generatedId;
  const errorId = error ? `${id}-err` : undefined;
  const hintId = hint ? `${id}-hint` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div className="flex items-center justify-between gap-2">
        <label
          htmlFor={id}
          className={cn(
            'text-[13px] font-semibold text-slate-700 dark:text-slate-200',
            labelClassName,
          )}
        >
          {label}
          {required && (
            <span
              aria-hidden="true"
              className="ms-0.5 text-red-500 dark:text-red-400"
            >
              *
            </span>
          )}
        </label>
        {labelSuffix}
      </div>
      {children({ id, describedBy, ariaInvalid: !!error, ariaRequired: required })}
      {error && (
        <p
          id={errorId}
          role="alert"
          className="text-[12px] text-red-600 dark:text-red-400"
        >
          {error}
        </p>
      )}
      {hint && (
        <p
          id={hintId}
          className={cn(
            'text-[12px]',
            hintTone === 'warning'
              ? 'text-amber-600 dark:text-amber-400'
              : 'text-slate-500 dark:text-slate-400',
          )}
        >
          {hint}
        </p>
      )}
    </div>
  );
}

/**
 * Convenience wrapper for the text/email/password/number inputs the
 * People / Partners / Admin forms use dozens of times. Any input prop
 * not listed here (autoComplete, placeholder, min, max, step, etc.)
 * flows through to the underlying <input>.
 */
export interface TextFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'aria-invalid' | 'aria-describedby' | 'aria-required'>,
    Pick<FieldProps, 'label' | 'error' | 'hint' | 'hintTone' | 'required' | 'className' | 'labelClassName' | 'labelSuffix'> {
  /** Applied to the <input>, not the wrapper. */
  inputClassName?: string;
  /** Optional element rendered to the right of the input inside its border (icon buttons etc.). */
  trailing?: ReactNode;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(
  function TextField(
    {
      label,
      error,
      hint,
      hintTone,
      required,
      className,
      labelClassName,
      labelSuffix,
      inputClassName,
      trailing,
      type = 'text',
      ...inputProps
    },
    ref,
  ) {
    return (
      <Field
        label={label}
        htmlFor={inputProps.name}
        required={required}
        error={error}
        hint={hint}
        hintTone={hintTone}
        className={className}
        labelClassName={labelClassName}
        labelSuffix={labelSuffix}
      >
        {({ id, describedBy, ariaInvalid, ariaRequired }) => (
          <div className={cn('relative', trailing && 'flex items-stretch')}>
            <input
              {...inputProps}
              ref={ref}
              id={id}
              type={type}
              aria-invalid={ariaInvalid || undefined}
              aria-describedby={describedBy}
              aria-required={ariaRequired || undefined}
              className={cn(
                'w-full rounded-lg border bg-white dark:bg-slate-900 px-3 py-2 text-sm text-slate-900 dark:text-slate-100',
                'placeholder:text-slate-400 dark:placeholder:text-slate-500',
                'focus:outline-none focus:border-blue-500 dark:focus:border-blue-400',
                ariaInvalid
                  ? 'border-red-400 dark:border-red-500'
                  : 'border-slate-200 dark:border-slate-700',
                inputProps.disabled && 'opacity-60 cursor-not-allowed',
                inputClassName,
              )}
            />
            {trailing}
          </div>
        )}
      </Field>
    );
  },
);

/** Textarea variant — same wrapper contract as TextField. */
export interface TextAreaFieldProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id' | 'aria-invalid' | 'aria-describedby' | 'aria-required'>,
    Pick<FieldProps, 'label' | 'error' | 'hint' | 'hintTone' | 'required' | 'className' | 'labelClassName' | 'labelSuffix'> {
  textareaClassName?: string;
}

export const TextAreaField = forwardRef<HTMLTextAreaElement, TextAreaFieldProps>(
  function TextAreaField(
    { label, error, hint, hintTone, required, className, labelClassName, labelSuffix, textareaClassName, ...rest },
    ref,
  ) {
    return (
      <Field
        label={label}
        htmlFor={rest.name}
        required={required}
        error={error}
        hint={hint}
        hintTone={hintTone}
        className={className}
        labelClassName={labelClassName}
        labelSuffix={labelSuffix}
      >
        {({ id, describedBy, ariaInvalid, ariaRequired }) => (
          <textarea
            {...rest}
            ref={ref}
            id={id}
            aria-invalid={ariaInvalid || undefined}
            aria-describedby={describedBy}
            aria-required={ariaRequired || undefined}
            className={cn(
              'w-full rounded-lg border bg-white dark:bg-slate-900 px-3 py-2 text-sm text-slate-900 dark:text-slate-100',
              'placeholder:text-slate-400 dark:placeholder:text-slate-500',
              'focus:outline-none focus:border-blue-500 dark:focus:border-blue-400',
              ariaInvalid
                ? 'border-red-400 dark:border-red-500'
                : 'border-slate-200 dark:border-slate-700',
              rest.disabled && 'opacity-60 cursor-not-allowed',
              textareaClassName,
            )}
          />
        )}
      </Field>
    );
  },
);

/** Native <select> variant — same wrapper contract. */
export interface SelectFieldProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id' | 'aria-invalid' | 'aria-describedby' | 'aria-required'>,
    Pick<FieldProps, 'label' | 'error' | 'hint' | 'hintTone' | 'required' | 'className' | 'labelClassName' | 'labelSuffix'> {
  selectClassName?: string;
  children?: ReactNode;
}

export const SelectField = forwardRef<HTMLSelectElement, SelectFieldProps>(
  function SelectField(
    { label, error, hint, hintTone, required, className, labelClassName, labelSuffix, selectClassName, children, ...rest },
    ref,
  ) {
    return (
      <Field
        label={label}
        htmlFor={rest.name}
        required={required}
        error={error}
        hint={hint}
        hintTone={hintTone}
        className={className}
        labelClassName={labelClassName}
        labelSuffix={labelSuffix}
      >
        {({ id, describedBy, ariaInvalid, ariaRequired }) => (
          <select
            {...rest}
            ref={ref}
            id={id}
            aria-invalid={ariaInvalid || undefined}
            aria-describedby={describedBy}
            aria-required={ariaRequired || undefined}
            className={cn(
              'w-full rounded-lg border bg-white dark:bg-slate-900 px-3 py-2 text-sm text-slate-900 dark:text-slate-100',
              'focus:outline-none focus:border-blue-500 dark:focus:border-blue-400',
              ariaInvalid
                ? 'border-red-400 dark:border-red-500'
                : 'border-slate-200 dark:border-slate-700',
              rest.disabled && 'opacity-60 cursor-not-allowed',
              selectClassName,
            )}
          >
            {children}
          </select>
        )}
      </Field>
    );
  },
);
