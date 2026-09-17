import { InputHTMLAttributes } from 'react';
import { cx } from './vocabulary';

interface Props extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange' | 'className'> {
    value: number;
    min: number;
    max: number;
    step?: number;
    onChange: (next: number) => void;
    /** Accessible name. Required — a slider with no name announces only a number. */
    label: string;
    /** Spoken instead of the raw number ("120 percent" rather than "120"). */
    valueText?: string;
    className?: string;
}

/**
 * The app's range slider. Everything visual lives in `.app-slider`
 * (`src/index.css`), which explains why; this only computes the fill stop and
 * keeps the platform's keyboard behaviour intact.
 *
 * That keyboard behaviour is deliberately untouched: ←/↓ and →/↑ step by
 * `step`, PageUp/PageDown jump by a tenth of the range, Home/End go to the
 * ends. Nothing here re-implements it, because everyone already knows it.
 */
export default function Slider({ value, min, max, step = 1, onChange, label, valueText, className, ...rest }: Props) {
    const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
    return (
        <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={e => onChange(Number(e.target.value))}
            aria-label={label}
            aria-valuetext={valueText}
            style={{ ['--fill' as string]: `${pct}%` }}
            className={cx('app-slider', className)}
            {...rest}
        />
    );
}
