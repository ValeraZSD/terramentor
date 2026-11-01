# Why it works

Terramentor uses the model you connect to write lessons, questions and flashcards. The order you
meet them in is set by the app, not by the model: you answer questions after each part of a
lesson, see why each answer is right or wrong, pass a check before a topic counts as proven, and
get it back for review after a gap. Each of those steps is a study technique with a long research
record behind it, and the app is built like the trials below that put the AI into set lessons,
not like those that handed students a chatbot. This page sets out that evidence, what happened in trials where students were
given an AI chatbot or tutor, and what the AI companies' own study modes do today.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="evidence/effect-sizes-dark.svg">
  <img src="evidence/effect-sizes-light.svg" alt="Bar chart of effect sizes from research studies. Techniques the loop uses: testing instead of rereading 0.50, quizzes in classrooms 0.50, feedback 0.48, tests spread over time 0.74, a pass mark before moving on 0.29 on standardised tests. Tutoring: human tutoring 0.29, an AI tutor given worked solutions 0.63, AI maths practice in Ghana 0.36, AI in guided sessions in Nigeria 0.24, an AI maths coach 0.06 per school year, an AI assistant offered in university courses minus 0.29, not statistically significant. The last four are working papers or preprints.">
</picture>

Each bar is an effect size: how far the average learner who got the technique ended up above the
average learner in the comparison group, in standard deviations of the test scores (the comparison
group's, or both groups' together, depending on the study). At 0.5, a learner who would have been
in the middle of the class ends up at about the 69th percentile.
The line through a bar is its 95% interval: the paper's own, or computed from the standard error
it reports. A bar without a line has no interval here, which does not make it exact.

## The loop, step by step

**A question after each part of a lesson.** Being tested on material helps you remember it
better than reading it again. Across 61 studies, testing beat restudying by g = 0.50 (Rowland,
2014), and quizzes in real classrooms did as well: g = 0.50 across 222 studies and 48,478
students (Yang et al., 2021). In Rowland's data the gain was larger when the test came with
feedback (0.73) than without it (0.39), and recalling an answer helped more than picking it from
a list. In Terramentor each part of a lesson is followed by a question on it, and the topic's
mastery check and its flashcards are tests too. Some questions are multiple choice; others ask
you to type an answer, work out a number or put steps in order, and a flashcard asks you to
recall the answer before you turn it.

**An explanation after each answer.** Feedback on learning averaged d = 0.48 across 435 studies
and more than 61,000 people (Wisniewski, Zierer & Hattie, 2020). The authors stress that feedback
is not one thing: how much information it carries changes how much it helps. A question in
Terramentor shows its explanation once you have answered, not before.

**Reviews spread over days.** The same number of tests helps more when spread out than when
crammed into one session: g = 0.74 across 11 studies, after a correction for unpublished null
results (Latimier, Peyre & Ramus, 2021). Flashcards in Terramentor are scheduled with FSRS, an
open model of when you are likely to forget a card, and a proven topic that has gone unpractised
for a while comes back as recall questions in the stream and in practice quizzes.

**A pass mark before a topic counts.** In mastery learning, students move on only after passing a
check. Across 103 studies, mastery courses raised scores by 0.52 SD (Kulik, Kulik &
Bangert-Drowns, 1990), but most of those scores came from the courses' own exams. In the 11
studies that used standardised tests the same review found 0.29, the figure in the chart, and a
stricter review of school programmes found almost nothing (+0.04, Slavin, 1987). In a 2026 trial
with more than 6,000 middle-school pupils, requiring a pass mark during one practice session
made pupils answer more questions but gave no detectable gain on a test a week later
(Oreopoulos, Liut, Sungu & Low, 2026, a working paper). The fair claim is that a pass mark makes
you learn what the course teaches, not that it raises scores on every test, and its evidence is
the weakest of the four steps. In Terramentor, under the default setting ("Require proof"), a topic
counts as done only once you get 80% of its mastery check right, or of another quiz or paper
exercise of four or more questions, or once your answers so far put the estimate of what you know
above the bar. You can always skip a topic; it is then marked as skipped, not as known. Under "Ask
me" or "Just track" in Settings, a topic can be marked done without a pass.

Two techniques with evidence of similar size are not part of the loop: prompts to explain a step
in your own words (g = 0.55, Bisra et al., 2018) and questions asked before a lesson (g = 0.54 on
the questions asked, 0.04 on the rest of the lesson, St Hilaire, Chan & Ahn, 2023). Terramentor's
placement questions, taken before you study a course, look for what you already know across it;
they are not asked to prepare you for one lesson. The stream
does mix reviews of older topics in with new material. That is spacing. Interleaving in the
research sense means alternating similar kinds of problem so that you learn to tell them apart,
and its record is mixed: g = 0.42 on average, 0.34 for maths, and worse than blocked practice for
learning words (−0.39) (Brunmair & Richter, 2019).

## Students given a chatbot

**The answers were there, so students used them.** About 1,000 secondary-school students in
Turkey practised maths in four 90-minute sessions (Bastani et al., 2025, PNAS). With a plain
GPT-4 chat open, their practice scores rose by 48%. In the closed-book exam that followed, they
scored 17% below the classes that had no AI. A second version, given the teacher's solutions and
told to hint rather than answer, raised practice scores by 127% and left exam scores where they
were. Asked for the answers to these problems, the plain version was right only 51% of the time.
The paper reports its results as percentages, not standard deviations, so it has no bar in the
chart.

**An assistant offered in university courses.** At the University of Maryland, 30 instructors
were assigned at random to offer a course AI tutor or not (Liu et al., 2026, a working paper).
Across all 2,379 students, those offered the tutor ended with final grades about 0.29 SD lower, a
difference that was not statistically significant; the authors put that down to courses that
were taught and graded differently. Comparing only sections of the same course (1,353 students),
grades were 0.37 SD lower and participation on the course website 0.90 SD lower. Only about 15%
of those offered the tutor used it, and three in four requests asked for information,
explanations or solutions.

**Not every study finds harm.** In a preregistered online study of 704 adults learning fractions
(Maier et al., 2026, a preprint), plain AI help did not lower unaided scores. Showing learners how
they had been using the assistant roughly halved the odds that they asked it for the answer (odds
ratio 0.47) and raised the odds of a right answer on the test without it (odds ratio 1.51). Both
effects were small enough to pass only the one-sided tests the authors had planned in advance.

## Students given AI inside guided practice

Four trials put the AI inside work that someone had set up. Three found clear gains:

- **Harvard physics** (Kestin et al., 2025): 194 students, two lessons. The tutor's instructions
  held the instructors' step-by-step solutions, and it walked students through a worksheet.
  Students learned more than from the same lessons taught by active learning in class: 0.63 SD on
  the post-test, which the authors call an underestimate because many students hit the top
  score.
- **Ghana** (Henkel et al., 2024, a preprint): two 30-minute sessions a week of maths practice on
  a phone for eight months, d = 0.36 compared with schools that had no extra sessions. A quarter
  of the 637 pupils who sat the first test missed the second, leaving 477.
- **Nigeria** (De Simone et al., 2025, a World Bank working paper): twelve teacher-guided sessions
  over six weeks with a prompt prepared for each, 0.24 SD in English compared with pupils who had
  no sessions. 759 of the 1,328 pupils assigned sat the final test; the authors' checks for that
  loss left the result positive.

The fourth, and the largest, found a small gain. Khanmigo, set to coach rather than give answers,
was added to daily catch-up maths sessions in 18 Tennessee schools for two years (Oreopoulos &
Low, 2026, a working paper). Almost every student (96%) tried it, but the median student messaged
it in 17% of the sessions where they got a question wrong. Compared with the usual catch-up
lessons, scores rose by about 0.06 to 0.08 SD a year, which the authors note resembles what earlier
studies found for Khan Academy practice without AI.

In Ghana and Nigeria the comparison group had no extra sessions at all, so the gain belongs to
the sessions and the AI together. Human tutoring of school pupils averages 0.29 SD (Nickow,
Oreopoulos & Quan, 2024); that is a pooled average over many programmes, not a ranking against
any single trial above. Computer tutors built before chatbots raised scores by a median of 0.66
SD across 50 evaluations, and the size depended heavily on whether the test was written for the
course or was a standardised one (Kulik & Fletcher, 2016).

## What this means for the design

In the trials where AI helped, the learner did the work: someone had set the problems and written
or checked the answers. Where students were simply handed an assistant, many asked it for the
answers, and their scores without it fell or did not move. In Terramentor the model does most of
its work before you start: it writes the lesson, the questions and the answer keys, and a second
pass answers each question with one right answer without its key and drops the ones it disagrees
with. Open answers and code have many right forms, so for those it checks the worked answer instead
and drops one it finds broken. A question it could not check is kept for practice and never counts
as proof. The same holds for a paper exercise: when its worked answer could not be checked you can
still work it and mark it, but the mark counts only if a later check confirmed that answer before
you marked it. (Exercises written by app versions older than this rule kept no record of that
check, so marks on them still count.) You answer before you see the explanation, and the checks and the reviews are
what count. The assistant is there for questions, but nothing said in
the chat is recorded as proof of what you know. It
explains directly, and it will answer a check's question if you paste it in: the
check measures what you know for your own sake, and it cannot stop you asking.

## What the AI companies' study modes do

OpenAI, Google and Anthropic each offer a way to study with their chat apps, and they add to
them every few months. This is what each company's own pages said on 1 November 2026.

- **ChatGPT study mode** (OpenAI, July 2025) is a switch in the message box. With it on, ChatGPT
  asks questions back, gives hints and checks your understanding instead of handing over the
  answer, though OpenAI's help page says it may still give one. It runs on instructions OpenAI
  wrote with teachers and learning scientists. ChatGPT also makes quizzes inside the chat, and
  flashcards that are saved in your library, where you mark each card as known or to practise
  again.
- **Gemini** (Google) has Guided Learning, a mode built on LearnLM, Google's models tuned for
  teaching. Since June 2026 it also has study notebooks: you upload your class material, a
  diagnostic quiz sets a baseline, and Gemini builds short lessons and quizzes, with a dashboard
  that marks more than 100 learning objectives as strengths, focus areas or not started. Gemini
  Notebook (formerly NotebookLM) makes flashcards from your sources and remembers which ones you
  missed.
- **Claude** (Anthropic) has a learning mode in Claude for Education, its plan for universities.
  It works inside Projects and answers with questions ("How would you approach this problem?")
  rather than solutions. Claude's consumer app is for people over 18, and Anthropic's help page on
  a learning style in it returned "page not found" on 1 November 2026, so the consumer app is left
  out here.

Microsoft's Study and Learn agent in Copilot, for school accounts aged 13 and over, makes
flashcards, scored quizzes, and matching and fill-in-the-blank exercises.

| | ChatGPT | Gemini | Claude | Terramentor |
| --- | --- | --- | --- | --- |
| Asks you questions instead of answering | Yes, in study mode | Yes, in Guided Learning | Yes, in learning mode (university plans) | The assistant explains directly unless you ask it to test you; the questions come from the lessons and checks |
| Quizzes | Yes, in the chat | Yes, including a diagnostic quiz and timed practice tests | When you ask in the chat | A question after each part of a lesson, and a mastery check per topic |
| Flashcards kept between sessions | Yes, marked known or to practise again | Yes, in Gemini Notebook | Not described | Yes |
| Reviews timed to when you are about to forget | Not described; you can ask ChatGPT to set a scheduled task | Not described | Not described | Cards scheduled with FSRS; recall questions for proven topics |
| A record of what you know | Chat memory | The study-notebook dashboard, from quiz results | Not described | Per topic, from answers, checks and card ratings |
| A pass mark before a topic counts | Not described | Not described | Not described | By default, a passed mastery check or quiz; a skipped topic is marked as skipped, not known |
| A plan with dates | In the chat, when you ask | A lesson plan in study notebooks; exam and due dates from a syllabus to Google Calendar, announced on 19 August 2026 for the following weeks | Not described | Start date, deadline and study days, planned again when they change |
| Published result for this product | OpenAI's own randomised study of over 300 students, early results, not peer-reviewed: about 15% higher exam scores in microeconomics than students without AI, no clear difference in neuroscience | LearnLM drafting messages that human tutors checked: 165 UK pupils did at least as well as with human tutors alone | None found for learning mode | None |
| Where your work is kept | Your OpenAI account; personal chats can be used for training unless you turn it off | Your Google account; for adults, Keep Activity is on by default and that activity is used for training | Your university's account; Anthropic's consumer rules on training do not apply to it | On your own disk: the library is one file, and your keys are in a second file beside it. What the model has to read (course material, chat messages, answers it grades) goes to the model provider you connect, under that provider's terms; with a model on your own computer it stays there. Search queries made from topic titles go to DuckDuckGo, Wikipedia, GitHub and any search service you add, while a course is drafted (one switch turns that off) and when you press Find resources. [SECURITY.md](../SECURITY.md) lists every connection |
| To start | Sign in on the web or the phone app | Sign in with a Google account, on the web or the phone app | Your university must have Claude for Education; you sign in with its email | Install it on your computer and connect a model |
| What it costs | Study mode, quizzes and flashcards are on every plan, the free one included | Free to start; paid plans allow more study notebooks. Students aged 18 or over in the countries Google lists who claim the offer by 31 December 2026 get a paid plan free for a year | Paid by the university | The app is free. A hosted model is paid per use under your own key, or runs on a ChatGPT plan you already have; a model run on your own computer costs nothing more |

"Not described" means the company's pages did not mention it, not that the feature cannot exist.

The study modes cover the conversation well, and Gemini's study notebooks add a plan, quizzes and
a progress record. None of the pages describes reviews timed by a model of forgetting, or a pass
mark a topic must clear before it counts: the spacing and pass-mark bars in the chart. None of
the trials in the sections above tested these study modes. They are designed to guide rather than
answer, and OpenAI's early results show a gain in one of its two courses.

## Limits

These are studies of the techniques, not of Terramentor. Most were run with students in
laboratories and classrooms, and many measured a test given soon after the practice. No one has
run a trial of Terramentor, so nothing here says how much it will raise anyone's scores.

The bars do not add up. Each compares a technique with a different alternative, on a different
test, in a different group of people, and the techniques overlap: most testing studies include
feedback, and spaced practice is spaced testing. Adding up the five bars of the first group does
not give a gain of 2.5 standard deviations. Most of the AI trials lasted a semester or less, and
most are not yet peer-reviewed.

Every one of these effects assumes the learner does the work. In the Khanmigo trial most students
rarely asked the coach, and an app that schedules reviews cannot make anyone open it. In the studies, teachers or researchers wrote the
questions. In Terramentor a model writes them and a second pass checks them, which catches many
errors but not all of them.

## Sources

Every figure in the chart, with the sentence it was taken from, is in
[`evidence/effect-sizes.json`](evidence/effect-sizes.json); `node tools/evidence-chart.mjs`
redraws the chart and this table from it.

<!-- evidence-table:start (generated by tools/evidence-chart.mjs; edit docs/evidence/effect-sizes.json) -->

| Result | Effect | 95% CI | Studies or people | Compared with | Note | Source |
| --- | --- | --- | --- | --- | --- | --- |
| **Techniques the loop uses · meta-analyses** | | | | | | |
| Testing instead of rereading | g = 0.50 | 0.42 to 0.58 | 61 studies, 159 effects | restudying the same material | Mostly lab studies with college students. With feedback g = 0.73, without g = 0.39. | [Rowland 2014, Psychological Bulletin](https://doi.org/10.1037/a0037559) |
| Quizzes in real classrooms | g = 0.50 | not extracted | 222 studies, 48,478 students | classes without the quizzes (restudy, other activities or nothing) | Real classes. The size depends on what the comparison classes did instead. | [Yang et al. 2021, Psychological Bulletin](https://doi.org/10.1037/bul0000309) |
| Feedback on answers | d = 0.48 | 0.44 to 0.51 | 435 studies, over 61,000 people | no feedback | After removing 35 extreme effects; d = 0.55 with them. Varies widely by kind of feedback. | [Wisniewski, Zierer & Hattie 2020, Frontiers in Psychology](https://doi.org/10.3389/fpsyg.2019.03087) |
| Tests spread over time | g = 0.74 | 0.55 to 0.91 | 11 studies, 39 effects | the same tests crammed into one session | Corrected for publication bias; g = 1.01 before. Mostly lab studies of word pairs. | [Latimier, Peyre & Ramus 2021, Educational Psychology Review](https://doi.org/10.1007/s10648-020-09572-8) |
| A pass mark before moving on | 0.29 SD | 0.11 to 0.47 | 11 studies with standardised tests | the same course without a pass mark | Standardised tests. 0.52 across all 103 studies, mostly the courses' own exams. Interval from the reported standard error. | [Kulik, Kulik & Bangert-Drowns 1990, Review of Educational Research](https://doi.org/10.3102/00346543060002265) |
| **Tutoring · trials and one meta-analysis** | | | | | | |
| Human tutoring, school pupils | 0.29 SD | 0.23 to 0.34 | randomised trials, pre-school to grade 12 | no tutoring | A pooled average over many programmes. Interval from the reported standard error. The 2020 working paper gave 0.37 across 96 trials. | [Nickow, Oreopoulos & Quan 2024, American Educational Research Journal](https://doi.org/10.3102/00028312231208687) |
| AI tutor given worked solutions | 0.63 SD | not extracted | 194 students, two lessons | the same lessons taught by active learning in class | Linear estimate; the authors give 0.73 to 1.3 allowing for the score ceiling. Post-test straight after. | [Kestin et al. 2025, Scientific Reports](https://doi.org/10.1038/s41598-025-97652-6) |
| AI maths practice, Ghana | d = 0.36 | not extracted | 477 pupils, 11 schools, 8 months | no extra activity | Preprint. Assigned by school, with no adjustment for that; a quarter missed the second test. The abstract says 0.37 and about 1,000 pupils; the analysis, 0.36 and 477. | [Henkel et al. 2024, arXiv 2402.09809](https://arxiv.org/abs/2402.09809) |
| AI in guided sessions, Nigeria | 0.24 SD | 0.10 to 0.37 | 1,328 pupils assigned, 759 tested, 6 weeks | no after-school programme | English, the main outcome; the abstract rounds it to 0.23. 0.31 on the whole test, which also covered the AI skills taught. Interval from the reported standard error. | [De Simone et al. 2025, World Bank Policy Research Working Paper 11125](https://doi.org/10.1596/1813-9450-11125) |
| AI maths coach, per year | 0.06 SD | not extracted | 18 schools, 6,902 pupil-terms over 2 years | the usual catch-up maths lessons | Working paper. 0.06 to 0.08 a school year; the chart shows the lower end. | [Oreopoulos & Low 2026, EdWorkingPaper 26-1551](https://doi.org/10.26300/kner-hv33) |
| AI assistant offered in courses | −0.29 SD | −0.60 to 0.03 | 2,379 students, 30 instructors | students of instructors randomly assigned not to offer it | Working paper. −2.88 grade points over a control-group SD of 10.10, interval from the reported standard error: not significant. −0.37 among sections of the same course (1,353 students). About 15% used it. | [Liu et al. 2026, IZA Discussion Paper 18989](https://www.iza.org/publications/dp/18989) |

<!-- evidence-table:end -->

Cited in the text only:

- Bastani, H. et al. (2025). Generative AI without guardrails can harm learning: evidence from
  high school mathematics. *PNAS* 122(26). <https://doi.org/10.1073/pnas.2422633122>
- Bisra, K. et al. (2018). Inducing self-explanation: a meta-analysis. *Educational Psychology
  Review* 30. <https://doi.org/10.1007/s10648-018-9434-x>
- Brunmair, M. & Richter, T. (2019). Similarity matters: a meta-analysis of interleaved learning
  and its moderators. *Psychological Bulletin* 145(11). <https://doi.org/10.1037/bul0000209>
- Kulik, J. A. & Fletcher, J. D. (2016). Effectiveness of intelligent tutoring systems: a
  meta-analytic review. *Review of Educational Research* 86(1).
  <https://doi.org/10.3102/0034654315581420>
- Maier, S. et al. (2026). Designing against deskilling: metacognitive feedback reduces cognitive
  offloading to LLM assistants. arXiv 2609.20143. <https://arxiv.org/abs/2609.20143>
- Oreopoulos, P., Liut, M., Sungu, A. & Low, N. (2026). Making AI tutoring productive: evidence
  from a mastery-based math practice experiment. EdWorkingPaper 26-1552.
  <https://doi.org/10.26300/01qv-6c22>
- Slavin, R. E. (1987). Mastery learning reconsidered. *Review of Educational Research* 57(2).
  <https://doi.org/10.3102/00346543057002175>
- St Hilaire, K. J., Chan, J. C. K. & Ahn, D. (2023). Guessing as a learning intervention: a
  meta-analytic review of the prequestion effect. *Psychonomic Bulletin & Review*.
  <https://doi.org/10.3758/s13423-023-02353-8>
- LearnLM Team, Google, and Eedi (2025). AI tutoring can safely and effectively support
  students: an exploratory RCT in UK classrooms. arXiv 2512.23633.
  <https://arxiv.org/abs/2512.23633>

Figures were read from each paper on 1 November 2026.

The study modes, as their companies describe them, read on 1 November 2026:

- OpenAI: [Introducing study mode](https://openai.com/index/chatgpt-study-mode/) (29 July 2025);
  [Using study mode in ChatGPT](https://help.openai.com/en/articles/11780217-using-study-mode-in-chatgpt);
  [Flashcards in ChatGPT](https://help.openai.com/en/articles/20001533-flashcards-in-chatgpt);
  [New tools for understanding AI and learning outcomes](https://openai.com/index/understanding-ai-and-learning-outcomes/)
  (4 March 2026);
  [How your data is used to improve model performance](https://help.openai.com/en/articles/5722486-how-your-data-is-used-to-improve-model-performance).
- Google: [Guided Learning](https://blog.google/outreach-initiatives/education/guided-learning/)
  (6 August 2025);
  [Study notebooks](https://blog.google/innovation-and-ai/products/gemini-app/gemini-study-notebooks/)
  (25 June 2026);
  [Gemini for students](https://blog.google/innovation-and-ai/products/gemini-app/student-offer-google-ai/)
  (19 August 2026);
  [Flashcards and quizzes in Gemini Notebook](https://support.google.com/notebooklm/answer/16958963);
  [Gemini Apps Privacy Hub](https://support.google.com/gemini/answer/13594961).
- Anthropic: [Introducing Claude for Education](https://www.anthropic.com/news/introducing-claude-for-education)
  (2 April 2025);
  [Updates to consumer terms](https://www.anthropic.com/news/updates-to-our-consumer-terms)
  (28 August 2025);
  [Age assurance on Claude](https://support.claude.com/en/articles/15171100-age-assurance-on-claude).
- Microsoft: [Study and Learn agent](https://support.microsoft.com/en-us/education/copilot/study-learn-agent).
