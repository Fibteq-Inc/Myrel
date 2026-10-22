-- github_user_repos now holds only repositories the person can push to. Rows from earlier GitHub
-- sign-ins also held ones they could only see, so they go: people sign in to GitHub again to pick
-- repositories, and connections made before keep working until then (see repoWritable).
DELETE FROM `github_user_repos`;
