import { useState, useEffect } from 'react';
import { api } from '../api';
import { ProjectQuiz } from '../types';
import { ArrowLeft, Award, Brain, Loader2, BarChart3 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface Props {
  projectId: number;
  onSelectQuiz: (quiz: ProjectQuiz) => void;
  onClose: () => void;
}

export default function ProjectQuizzesList({ projectId, onSelectQuiz, onClose }: Props) {
  const { t } = useTranslation();
  const [quizzes, setQuizzes] = useState<ProjectQuiz[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadQuizzes();
  }, [projectId]);

  const loadQuizzes = async () => {
    setLoading(true);
    try {
      const data = await api.getProjectQuizzes(projectId);
      setQuizzes(data);
    } catch (error) {
      console.error('Failed to load quizzes:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-slate-100 dark:bg-slate-900">
        <Loader2 className="w-8 h-8 text-accent-fg animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-slate-100 dark:bg-slate-900">
      {/* Header */}
      <div className="flex items-center gap-4 px-6 py-4 bg-white dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 shrink-0">
        <button
          onClick={onClose}
          aria-label={t("Go back")}
          className="p-2 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg text-slate-500 dark:text-slate-400 transition"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div>
          <h2 className="font-semibold text-slate-900 dark:text-white flex items-center gap-2">
            <Brain className="w-5 h-5 text-emerald-500" />
            {t("All Project Quizzes")}
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {t("{{count}} quizzes in this project", { count: quizzes.length })}
          </p>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-6">
        {quizzes.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-slate-500 dark:text-slate-400">
            <BarChart3 className="w-12 h-12 mb-3 opacity-50" />
            <p className="font-medium">{t("No quizzes found")}</p>
            <p className="text-sm mt-1">{t("Generate quizzes from your study topics to see them here.")}</p>
          </div>
        ) : (
          <div className="max-w-3xl mx-auto space-y-3">
            {quizzes.map(quiz => {
              const scoreColor = quiz.best_score !== null && quiz.best_score !== undefined
                ? quiz.best_score >= 80 ? 'text-emerald-500' : quiz.best_score >= 60 ? 'text-amber-500' : 'text-red-500'
                : 'text-slate-400';

              const quizDate = quiz.title.replace(/^Quiz\s*-\s*/i, '').trim();

              return (
                <div
                  key={quiz.id}
                  className="flex items-center justify-between p-4 bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 hover:border-accent/40 dark:hover:border-accent transition shadow-sm"
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-slate-800 dark:text-slate-200 truncate">
                      {quiz.node_title || t("Unknown topic")}
                    </p>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 flex items-center gap-2 flex-wrap">
                      {quizDate && <span>{quizDate}</span>}
                      {quizDate && <span>•</span>}
                      <span>{t("{{length}} questions", { count: quiz.questions.length, length: quiz.questions.length })}</span>
                      <span>•</span>
                      <span>{quiz.attempt_count || 0} {t("attempts")}</span>
                    </p>
                  </div>
                  
                  <div className="flex items-center gap-4 ml-4 shrink-0">
                    {quiz.best_score !== null && quiz.best_score !== undefined ? (
                      <div className="text-right">
                        <p className={`text-2xl font-bold ${scoreColor}`}>
                          {quiz.best_score}%
                        </p>
                        <p className="text-[11px] text-slate-400 font-medium">{t("Best Score")}</p>
                      </div>
                    ) : (
                      <div className="text-right">
                        <p className="text-sm text-slate-500 dark:text-slate-400">{t("Not taken")}</p>
                      </div>
                    )}
                    <button
                      onClick={() => onSelectQuiz(quiz)}
                      className="flex items-center gap-2 px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 transition"
                    >
                      <Award className="w-4 h-4" />
                      {quiz.attempt_count ? t("Retake") : t("Take Quiz")}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}