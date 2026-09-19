import type { StudentProblemsFile } from '../../../../src/shared/types/draft';

/**
 * Arabic strings for the Student Problems section (T4.3.4 follow-up).
 *
 * The content bundle (`content/versions/v{N}/student-problems-statements.json`) only carries English
 * text — translating it is a content-team decision the PRD leaves open (Section 23.1), not something
 * this patch can make on the content's behalf. What the product needs *now* is for the section to
 * default to Arabic and let a student switch to English, so this is a UI-layer translation keyed by
 * the same ids the content already uses (`area.id`, `statement.id`, `scale[].value`). If and when the
 * content team ships Arabic in the bundle itself, this file becomes the fallback rather than the
 * source, and nothing about the component needs to change to prefer it.
 *
 * Written against **content version v2** (`content/versions/v2/student-problems-statements.json`,
 * shipped as `current-version.json` in the commit that added this dictionary). v1 had 15 statements;
 * v2 renumbers and rewords several of them and adds five more (sp-16–sp-20), which is exactly the
 * kind of drift this file cannot detect on its own — a statement id is stable across versions but its
 * *wording* is not guaranteed to be, so a translation keyed only by id can go stale silently. Two
 * things guard against that: `translateStudentProblems` below warns in development when the live
 * content names a statement/area this dictionary has no entry for, and the component's own lookup
 * (`t.statements[id] ?? statement.text`) falls back to the instrument's own English rather than
 * rendering nothing — so a future content bump degrades to "one statement shows in English on an
 * Arabic-default page" rather than a broken section.
 */
export type StudentProblemsLanguage = 'ar' | 'en';

export interface StudentProblemsTranslation {
  instructions: string;
  scale: Record<number, string>;
  areas: Record<string, string>;
  statements: Record<string, string>;
  openTextQuestion: {
    prompt: string;
    privacyNoticeHeading: string;
    privacyNotice: string;
    hint: string;
  };
}

export const STUDENT_PROBLEMS_AR: StudentProblemsTranslation = {
  instructions:
    'تصف العبارات التالية بعض الصعوبات الشائعة التي يواجهها الطلاب عند تعلّم اللغة الإنجليزية. لكل عبارة، اختر الإجابة التي تصف تجربتك الشخصية على أفضل وجه. لا توجد إجابات صحيحة أو خاطئة، وإجاباتك لا تؤثر على درجتك في اللغة الإنجليزية.',
  scale: {
    1: 'غير موافق بشدة',
    2: 'غير موافق',
    3: 'محايد',
    4: 'موافق',
    5: 'موافق بشدة',
  },
  areas: {
    speaking_confidence: 'التحدث والثقة',
    listening: 'الاستماع',
    vocabulary: 'المفردات',
    grammar: 'القواعد',
    reading: 'القراءة',
    writing: 'الكتابة',
    learning_habits: 'عادات التعلّم والممارسة',
  },
  statements: {
    'sp-01': 'أجد صعوبة في التحدث بالإنجليزية بثقة أمام الآخرين.',
    'sp-02': 'أتردد في التحدث بالإنجليزية لأنني أخاف من ارتكاب الأخطاء.',
    'sp-03': 'أجد صعوبة في التحدث بالإنجليزية دون تحضير مسبق لما سأقوله.',
    'sp-04': 'أجد صعوبة في متابعة الإنجليزية المنطوقة في الأفلام أو الفيديوهات أو الأحاديث اليومية.',
    'sp-05': 'أجد صعوبة في فهم الإنجليزية عندما يتحدث الناس بسرعة.',
    'sp-06': 'أجد صعوبة في فهم متحدثي الإنجليزية الذين لديهم لكنة مختلفة عمّا اعتدت عليه.',
    'sp-07': 'كثيرًا ما لا أجد الكلمة الإنجليزية المناسبة أثناء التحدث.',
    'sp-08': 'أنسى كلمات إنجليزية سبق أن درستها.',
    'sp-09': 'أفهم كلمات إنجليزية أكثر مما أستطيع استخدامه بنفسي.',
    'sp-10': 'أجد صعوبة في تطبيق قواعد اللغة الإنجليزية عند الكتابة.',
    'sp-11': 'أرتكب أخطاء نحوية عند التحدث، حتى عندما أعرف القاعدة.',
    'sp-12': 'أترجم من العربية إلى الإنجليزية في ذهني قبل تكوين الجملة.',
    'sp-13': 'أجد النصوص الإنجليزية الأكاديمية صعبة الفهم.',
    'sp-14': 'كثيرًا ما أتوقف عند الكلمات التي لا أعرفها عندما أقرأ بالإنجليزية.',
    'sp-15': 'أحتاج إلى قراءة الجملة الإنجليزية أكثر من مرة لفهمها.',
    'sp-16': 'أجد صعوبة في تنظيم أفكاري عند الكتابة بالإنجليزية.',
    'sp-17': 'أجد صعوبة في ملاحظة أخطائي الخاصة عند مراجعة كتابتي.',
    'sp-18': 'لدي فرص قليلة لممارسة الإنجليزية خارج الصف.',
    'sp-19': 'نادرًا ما أقرأ بالإنجليزية خارج نطاق دراستي.',
    'sp-20': 'نادرًا ما أستمع إلى الإنجليزية خارج نطاق دراستي.',
  },
  openTextQuestion: {
    prompt:
      'هل هناك أي شيء آخر يجعل تعلّم الإنجليزية صعبًا بالنسبة لك؟ صِف ذلك بكلماتك الخاصة. يمكنك الكتابة بالإنجليزية أو العربية.',
    privacyNoticeHeading: 'قبل أن تجيب',
    privacyNotice:
      'يُرجى عدم ذكر أسماء أشخاص آخرين، أو أرقام هواتف، أو كلمات مرور، أو أي تفاصيل خاصة مشابهة في إجابتك.',
    hint: 'يمكنك الإجابة بالإنجليزية أو العربية. هذا السؤال اختياري — يمكنك الإرسال دون الإجابة عليه.',
  },
};

/** Reads back the instrument's own English text, so "EN" is always exactly what the content bundle says. */
export function englishTranslation(instrument: StudentProblemsFile): StudentProblemsTranslation {
  return {
    instructions: instrument.instructions,
    scale: Object.fromEntries(instrument.scale.map((point) => [point.value, point.label])),
    areas: Object.fromEntries(instrument.areas.map((area) => [area.id, area.label])),
    statements: Object.fromEntries(
      instrument.statements.map((statement) => [statement.id, statement.text]),
    ),
    openTextQuestion: {
      prompt: instrument.openTextQuestion.prompt,
      privacyNoticeHeading: instrument.openTextQuestion.privacyNoticeHeading,
      privacyNotice: instrument.openTextQuestion.privacyNotice,
      hint: 'You may answer in English or Arabic. This question is optional — you can submit without answering it.',
    },
  };
}

/**
 * The translation to render for `language`, checked against what the *live* content actually
 * contains.
 *
 * English is always derived fresh from `instrument`, so it can never go stale. Arabic is the static
 * dictionary above, so it can — this is where that gets caught: in development, a statement or area
 * id present in the content but absent from `STUDENT_PROBLEMS_AR` is logged once, by id, so the gap
 * shows up while building against new content rather than being discovered by a bilingual reader
 * later. It is intentionally not thrown — a missing translation should degrade to English for that
 * one line, not take the whole section down.
 */
export function translateStudentProblems(
  instrument: StudentProblemsFile,
  language: StudentProblemsLanguage,
): StudentProblemsTranslation {
  if (language === 'en') return englishTranslation(instrument);

  if (import.meta.env.DEV) {
    const missingStatements = instrument.statements
      .map((statement) => statement.id)
      .filter((id) => !(id in STUDENT_PROBLEMS_AR.statements));
    const missingAreas = instrument.areas
      .map((area) => area.id)
      .filter((id) => !(id in STUDENT_PROBLEMS_AR.areas));

    if (missingStatements.length > 0 || missingAreas.length > 0) {
      // eslint-disable-next-line no-console -- deliberate, dev-only content/translation drift warning
      console.warn(
        '[studentProblemsTranslations] STUDENT_PROBLEMS_AR is missing entries for the content ' +
          'currently loaded — falling back to English for these. Statements: ' +
          `${missingStatements.join(', ') || 'none'}. Areas: ${missingAreas.join(', ') || 'none'}.`,
      );
    }
  }

  return STUDENT_PROBLEMS_AR;
}
