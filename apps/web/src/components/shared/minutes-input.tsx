import { useState, useEffect, useCallback } from 'react';
import { minutesToDisplay, displayToMinutes } from '@/types';
import { cn } from '@/lib/utils';

interface MinutesInputProps {
  value: number;
  onChange: (minutes: number) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}

export function MinutesInput({
  value,
  onChange,
  placeholder = '0h 0m',
  className,
  disabled,
}: MinutesInputProps) {
  const [displayValue, setDisplayValue] = useState(() =>
    value ? minutesToDisplay(value) : '',
  );
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) {
      setDisplayValue(value ? minutesToDisplay(value) : '');
    }
  }, [value, focused]);

  const handleBlur = useCallback(() => {
    setFocused(false);
    const minutes = displayToMinutes(displayValue);
    onChange(minutes);
    setDisplayValue(minutes ? minutesToDisplay(minutes) : '');
  }, [displayValue, onChange]);

  return (
    <input
      type="text"
      value={displayValue}
      onChange={(e) => setDisplayValue(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={handleBlur}
      placeholder={placeholder}
      disabled={disabled}
      className={cn(
        'rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50',
        className,
      )}
    />
  );
}
