export const managesAttendance=user=>['admin','receptionist'].includes(user.role);
export function seesAttendance(user,conversation){
  return user.tenant===conversation.tenant&&(managesAttendance(user)||conversation.assigned_to===user.id||(!conversation.assigned_to&&conversation.status==='open'));
}
export function worksAttendance(user,conversation){
  return user.role!=='viewer'&&seesAttendance(user,conversation)&&(managesAttendance(user)||conversation.assigned_to===user.id);
}
export function canReplyAttendance(user,conversation){
  return !!conversation.assigned_to&&conversation.status==='open'&&worksAttendance(user,conversation);
}
