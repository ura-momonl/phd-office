// Explicit, user-approved default-calendar meetings. No polling, updates or deletes.
import {bodyText} from './reply.mjs';
const emailPattern=/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;
export const calendarTools=[
  {name:'microsoft_outlook_email.create_event_native',
    description:'Create a real Outlook meeting and immediately invite all approved attendees. Requires Calendars.ReadWrite and confirmed_by_user:true; sends once and reads the event back.',
    inputSchema:{type:'object',properties:{subject:{type:'string'},text_content:{type:'string'},location:{type:'string'},
      start_utc:{type:'string',description:'UTC timestamp YYYY-MM-DDTHH:mm:ssZ; convert the approved local time before calling.'},
      end_utc:{type:'string'},attendees:{type:'array',items:{type:'object',properties:{email:{type:'string'},name:{type:'string'}},required:['email']}}},
      required:['subject','text_content','location','start_utc','end_utc','attendees']},annotations:{readOnlyHint:false}},
  {name:'microsoft_outlook_email.fetch_event_native',description:'Read a known Outlook event through Graph; never sends an invitation.',
    inputSchema:{type:'object',properties:{event_id:{type:'string'}},required:['event_id']},annotations:{readOnlyHint:true}}
];
export function calendarEventBody(args,transactionId) {
  for(const field of ['subject','text_content','location'])
    if(typeof args[field]!=='string'||!args[field].trim())throw new Error('Meeting '+field+' is required');
  for(const field of ['start_utc','end_utc']) {
    const value=args[field];
    if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value)||
      !Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value.replace('Z','.000Z'))
      throw new Error('Meeting '+field+' must be a valid explicit UTC timestamp YYYY-MM-DDTHH:mm:ssZ');
  }
  if(Date.parse(args.end_utc)<=Date.parse(args.start_utc))throw new Error('Meeting end must follow start');
  if(!Array.isArray(args.attendees)||!args.attendees.length||args.attendees.some(r=>
    !r||typeof r.email!=='string'||!emailPattern.test(r.email)||r.name!=null&&typeof r.name!=='string'||
    Object.keys(r).some(k=>!['email','name'].includes(k))))throw new Error('Explicit approved meeting attendees are required');
  if(new Set(args.attendees.map(r=>r.email.toLowerCase())).size!==args.attendees.length)throw new Error('Duplicate meeting attendees');
  return {subject:args.subject,body:{contentType:'Text',content:args.text_content},
    start:{dateTime:args.start_utc.slice(0,-1),timeZone:'UTC'},end:{dateTime:args.end_utc.slice(0,-1),timeZone:'UTC'},
    location:{displayName:args.location},attendees:args.attendees.map(r=>({emailAddress:{address:r.email,...(r.name?{name:r.name}:{})},type:'required'})),
    responseRequested:true,isOnlineMeeting:false,transactionId};
}
export const eventPath=id=>{
  if(typeof id!=='string'||!id.trim())throw new Error('event_id is required');
  if(!/^[A-Za-z0-9+/_=-]+$/.test(id))throw new Error('event_id must be the raw opaque Graph ID, not a path or URL');
  return '/me/events/'+encodeURIComponent(id);
};
const headers={Prefer:'IdType="ImmutableId", outlook.timezone="UTC"'};
const audience=items=>(items||[]).map(r=>r.emailAddress.address.toLowerCase()+':'+r.type).sort();
const timestamp=value=>value?.timeZone==='UTC'?Date.parse(value.dateTime.replace(/Z$/,'')+'Z'):NaN;
export function verifyCalendarEvent(event,expected) {
  const text=body=>bodyText(body).replace(/\s+/g,' ').trim();
  // Exchange can persist Text as generated HTML. Compare the full readable body,
  // never the truncated bodyPreview or a requirement to keep the same encoding.
  return event.subject===expected.subject&&event.location?.displayName===expected.location.displayName&&
    text(event.body)===text(expected.body)&&
    timestamp(event.start)===timestamp(expected.start)&&timestamp(event.end)===timestamp(expected.end)&&
    JSON.stringify(audience(event.attendees))===JSON.stringify(audience(expected.attendees))&&
    event.isCancelled===false&&event.isOrganizer===true&&event.responseRequested===true;
}
export async function createCalendarEvent(graph,args,transactionId) {
  const body=calendarEventBody(args,transactionId);
  if(!graph.status?.scopes?.includes('Calendars.ReadWrite'))throw new Error('Calendar permission missing; run mail graph-login calendar, then finish Microsoft consent');
  // POST itself sends invitations. Do not create a draft then send it a second time.
  const created=await graph.request('POST','/me/events',body,headers);
  if(!created?.id)throw new Error('No event ID returned; creation outcome unknown; do not retry');
  let verification;
  try {
    const event=await graph.request('GET',eventPath(created.id),undefined,headers);
    const matches=verifyCalendarEvent(event,body);
    verification={status:matches?'verified':'mismatch',event};
  } catch(error) {verification={status:'error',error:error.message,no_automatic_retry:true};}
  return {isError:false,structuredContent:{id:created.id,status:'created_invitations_requested',verification},content:[]};
}
export async function fetchCalendarEvent(graph,id) {
  return {isError:false,structuredContent:await graph.request('GET',eventPath(id),undefined,headers),content:[]};
}
