// Scheduling only: a false result means review now, not that the mail is actionable.
// Inspect the full normalized text before packet excerpts are cut. Uncertain or
// task/research/teaching-related mail never waits merely to fill a batch.
export function canBatch(m, related, researchKeywords = []) {
  const text = m.subject + ' ' + m.text;
  return m.folder === 'inbox' && !!m.text.trim() && !related.length
    && !researchKeywords.some(keyword => text.toLowerCase().includes(keyword.toLowerCase()))
    && !/piazza|instructure|canvas/i.test(m.sender + ' ' + m.subject)
    && !/\burgent\b|\basap\b|\btoday\b|\btomorrow\b|\btonight\b|\bdeadline\b|\bdue\b|\brequired\b|\bmandatory\b|\bplease\b|\bconfirm\b|\breply\b|\brespond\b|\bsubmit\b|\brsvp\b|\bquote\b|\bquotation\b|\binvoice\b|\bpayment\b|\bfee\b|\bcancel\w*\b|\bsecurity\b|\bpassword\b|sign.?in|\btraining\b|\borientation\b|\bexam\b|\bgrade\b|\breservation\b|\benroll\w*\b|\bregistration\b|\bwithin\s+\d|\d{1,2}:\d{2}|紧急|今天|明天|今晚|截止|必须|要求|请|回复|提交|付款|费用|报价|培训|考试|预约|取消|密码/i.test(text);
}

// Coarse screening keeps clear notifications out of the AI queue; it never changes the mailbox.
export function screen(m, related, researchKeywords = []) {
  const sender = m.sender.toLowerCase(), text = m.subject + ' ' + m.text;
  if (sender === 'fomsupport@engr.wisc.edu' && /^FOM: A session is cancelled on /i.test(m.subject)
      && !/your (?:reservation|booked session).*cancel/i.test(m.text)) return 'optional-fom-opening';
  if (related.length || m.folder === 'sent') return null;
  if (researchKeywords.some(keyword => text.toLowerCase().includes(keyword.toLowerCase()))) return null;
  if (/piazza|instructure|canvas/i.test(sender + ' ' + m.subject)) return null;
  if (/action required|mandatory|required|deadline|due (?:by|on)|please (?:reply|respond|confirm|complete|submit)|quote|quotation|invoice|purchase order|payment|order\s*#|issue\s*#|security|password|sign.?in|Bayh.?Dole|training|考试|截止|付款|报价|培训|请回复/i.test(text)) return null;
  const bulkSubject = /newsletter|digest|roundup|weekly (?:update|news|events)|monthly (?:update|news)|news bulletin|sale|promotion|special offer|新闻简报|促销/i.test(m.subject);
  const bulkMarker = /unsubscribe|manage (?:your )?(?:email |subscription|preferences)|view (?:this email |email )?in (?:your )?browser|退订/i.test(m.text);
  const mailingList = /(?:@g-groups\.wisc\.edu|@lists\.)/i.test(sender);
  if (bulkSubject && (bulkMarker || mailingList || /newsletter|digest|marketing|noreply|no-reply|notifications/i.test(sender))) return 'bulk-information';
  if (mailingList && /seminar|webinar|career|public lecture|colloquium|讲座/i.test(m.subject)
      && m.text.length >= 80 && !/\?|reply|respond|confirm|RSVP/i.test(m.text)) return 'optional-public-event';
  return null;
}
