// Shared by receipt browsing and notification visibility. Every check uses
// current conversation membership and the workspace stored with the receipt.
export const MEETING_RECIPIENT_FROM = `FROM ot_meeting_share_recipients addressed
  JOIN ot_meeting_shares s ON s.id=addressed.share_id
  JOIN ot_conversations c ON c.id=s.conversation_id
  JOIN ot_conversation_members viewer ON viewer.conversation_id=c.id AND viewer.owner_id=addressed.recipient_id
  JOIN ot_conversation_members author ON author.conversation_id=c.id AND author.owner_id=s.sender_id
  LEFT JOIN ot_teams receipt_team ON receipt_team.workspace_id=s.workspace_id`;

export const MEETING_RECIPIENT_VISIBLE = `s.revoked_at IS NULL AND COALESCE(c.dm_key,'') NOT LIKE 'agent:%'
  AND (
    (receipt_team.id IS NOT NULL AND (c.team_id=receipt_team.id OR (c.kind='dm' AND c.team_id IS NULL))
      AND EXISTS (SELECT 1 FROM ot_team_members teammate WHERE teammate.team_id=receipt_team.id
        AND teammate.owner_id=addressed.recipient_id AND teammate.suspended=0)
      AND EXISTS (SELECT 1 FROM ot_team_members teammate WHERE teammate.team_id=receipt_team.id
        AND teammate.owner_id=s.sender_id AND teammate.suspended=0))
    OR (s.workspace_id IS NULL AND c.team_id IS NULL AND (c.account_group=1 OR (c.kind='dm' AND (
      EXISTS (SELECT 1 FROM ot_contacts contact
        WHERE contact.owner_a=MIN(addressed.recipient_id,s.sender_id)
        AND contact.owner_b=MAX(addressed.recipient_id,s.sender_id) AND contact.status='accepted')
      OR EXISTS (SELECT 1 FROM ot_team_members viewer_team
        JOIN ot_team_members sender_team ON sender_team.team_id=viewer_team.team_id
        WHERE viewer_team.owner_id=addressed.recipient_id AND viewer_team.suspended=0
        AND sender_team.owner_id=s.sender_id AND sender_team.suspended=0)
    ))))
  )`;
