const { LINKEDIN_ACCESS_TOKEN, LINKEDIN_AUTHOR_URN } = process.env
if (!LINKEDIN_ACCESS_TOKEN || !LINKEDIN_AUTHOR_URN) {
  console.error("Missing LINKEDIN_ACCESS_TOKEN or LINKEDIN_AUTHOR_URN")
  process.exit(1)
}

const body = {
  author: LINKEDIN_AUTHOR_URN,
  lifecycleState: "DRAFT",
  specificContent: {
    "com.linkedin.ugc.ShareContent": {
      shareCommentary: {
        text: "This is a test draft from the LinkedIn posting pipeline. If you see this, the DRAFT lifecycle works.",
      },
      shareMediaCategory: "NONE",
    },
  },
  visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
}

const res = await fetch("https://api.linkedin.com/v2/ugcPosts", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${LINKEDIN_ACCESS_TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(body),
})

const data = await res.json()
console.log(`Status: ${res.status}`)
console.log(`Response: ${JSON.stringify(data, null, 2)}`)
if (res.ok) {
  console.log("✓ DRAFT post created successfully — URN:", data.id)
} else {
  process.exit(1)
}
