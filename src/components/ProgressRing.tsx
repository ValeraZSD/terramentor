interface Props {
    progress: number;
    color: string;
    size?: number;
}

export default function ProgressRing({ progress, color, size = 40 }: Props) {
    const radius = (size - 4) / 2;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference - (progress / 100) * circumference;

    return (
        <div className="relative" style={{ width: size, height: size }}>
            <svg className="transform -rotate-90" width={size} height={size}>
                <circle
                    cx={size / 2}
                    cy={size / 2}
                    r={radius}
                    stroke="currentColor"
                    strokeWidth="3"
                    fill="none"
                    className="text-slate-200 dark:text-slate-700"
                />
                <circle
                    cx={size / 2}
                    cy={size / 2}
                    r={radius}
                    stroke={color}
                    strokeWidth="3"
                    fill="none"
                    strokeLinecap="round"
                    strokeDasharray={circumference}
                    strokeDashoffset={offset}
                    className="transition-all duration-300"
                />
            </svg>
            {/* Neutral, always-legible % — the coloured arc already carries the
                project colour, so the number needn't (and low/light project
                colours made it fail contrast against the card). */}
            <span className="absolute inset-0 flex items-center justify-center text-xs font-semibold text-slate-700 dark:text-slate-200">
                {progress}%
            </span>
        </div>
    );
}